import { Construct, Duration, RemovalPolicy } from "@aws-cdk/core";
import cloudwatch = require('@aws-cdk/aws-cloudwatch');
import lambda = require('@aws-cdk/aws-lambda');
import dynamo = require('@aws-cdk/aws-dynamodb');
import sqs = require('@aws-cdk/aws-sqs');
import subscriptions = require('@aws-cdk/aws-sns-subscriptions');
import sns = require('@aws-cdk/aws-sns');
import sources = require('@aws-cdk/aws-lambda-event-sources');
import { NodeFunction } from "../util/node-function";
import { PackageTableAttributes } from "../lambda-util";
import ids = require('./lambda/ids');
import secrets = require('@aws-cdk/aws-secretsmanager');
import { Schedule } from "@aws-cdk/aws-events";
import { AtomicCounter } from "../util/atomic-counter";
import { PolicyStatement } from "@aws-cdk/aws-iam";

export interface IndexerProps {
  /**
   * The input topic.
   */
  readonly input: sns.Topic;

  /**
   * Twitter credentials.
   * @default - do not publish to Twitter
   */
  readonly twitterCredentials?: secrets.ISecret;

  /**
   * The allowed rate of tweets.
   * @default - 300 tweets every 3 hours
   */
  readonly rate?: TweetRate;
}

export interface TweetRate {
  /**
   * Number of tweets per the defined window
   * @default 300
   */
  readonly quota?: number;

  /**
   * The time-window in which the quota is allows to be posted
   * @default Duration.hours(3)
   */
  readonly window?: Duration;
}

export class Indexer extends Construct {
  public readonly tweetsPerFiveMinute: cloudwatch.Metric;
  public readonly logGroup: string;
  public readonly table: dynamo.Table;

  constructor(scope: Construct, id: string, props: IndexerProps) {
    super(scope, id);

    const rate = props.rate || { };
    const quota = rate.quota || 300;
    const window = rate.window || Duration.hours(3);
    const lambdaTimeout = Duration.seconds(30);

    const queue = new sqs.Queue(this, 'Queue', {
      visibilityTimeout: lambdaTimeout
    });

    props.input.addSubscription(new subscriptions.SqsSubscription(queue));

    const table = new dynamo.Table(this, 'Table', {
      partitionKey: { type: dynamo.AttributeType.STRING, name: PackageTableAttributes.NAME, },
      sortKey: { type: dynamo.AttributeType.STRING, name: PackageTableAttributes.VERSION, },
      removalPolicy: RemovalPolicy.DESTROY
    });

    const requestQuota = new AtomicCounter(this, 'RequestQuota', {
      initialValue: quota,
      autoReset: {
        period: Schedule.rate(window)
      }
    });

    if (!requestQuota.autoResetTopic) {
      throw new Error(`assertion failed`);
    }

    const tweets = new sns.Topic(this, 'Tweets');

    const handler = new NodeFunction(this, 'Function', {
      codeDirectory: __dirname + '/lambda',
      timeout: lambdaTimeout,
      dependencies: [ 'twitter' ],
      environment: {
        [ids.Environment.TABLE_NAME]: table.tableName,
        [ids.Environment.TWITTER_SECRET_ARN]: props.twitterCredentials?.secretArn ?? '',
        [ids.Environment.TOPIC_ARN]: tweets.topicArn
      },

      // one event at a time (concurrently), since the auto-resetting request
      // quota atomic counter is decremented by 1 every time, and will throw an
      // exception in case we've reached our quota. this means messages will
      // return to the queue and retried after the visibility timeout.
      events: [ new sources.SqsEventSource(queue, { batchSize: 1 }) ],
    });


    props.twitterCredentials?.grantRead(handler);
    table.grantReadWriteData(handler);
    requestQuota.grantDecrement(handler);
    tweets.grantPublish(handler);

    this.tweetsPerFiveMinute = tweets.metricNumberOfMessagesPublished();
    this.logGroup = `/aws/lambda/${handler.functionName}`;
    this.table = table;

    // ------
    // allow main handler and redrive handler to update the event source mapping
    // so we can disable/enable queue based on the atomic counter state.

    // we need to access the EventSourceMapping resource due to:
    // https://github.com/aws/aws-cdk/issues/5430
    const eventSource = handler.node.children.find(child => child.node.id.startsWith('SqsEventSource:'));
    const cfnEventSourceMapping = eventSource?.node.defaultChild as lambda.CfnEventSourceMapping;
    if (!cfnEventSourceMapping) {
      throw new Error(`Unable to find the AWS::Lambda::EventSourceMapping resource`);
    }
    const eventSourceMappingId = cfnEventSourceMapping.ref;
    const updateEventSourceMapping = new PolicyStatement({
      actions: [ 'lambda:UpdateEventSourceMapping', 'lambda:ListEventSourceMappings' ],
      resources: [ '*' ], // otherwise we'll have a cyclic dependency
    });

    handler.addToRolePolicy(updateEventSourceMapping);

    // when the counter is reset, enable the event source mapping.
    const enableEventSourceHandler = new NodeFunction(this, 'EnableEventSourceFunction', {
      codeDirectory: __dirname + '/lambda',
      indexFile: 'enable_event_source',
    });

    enableEventSourceHandler.addEventSource(new sources.SnsEventSource(requestQuota.autoResetTopic))
    enableEventSourceHandler.addEnvironment(ids.Environment.EVENT_SOURCE_ID, eventSourceMappingId);
    enableEventSourceHandler.addToRolePolicy(updateEventSourceMapping);
  }
}
