#!/bin/bash
# Creates the SQS queues used by the service. Idempotent: CreateQueue with identical
# attributes is a no-op in SQS.
set -euo pipefail

INPUT_QUEUE="wager-transactions.fifo"
DLQ="wager-transactions-dlq.fifo"
EVENTS_QUEUE="wagering-events.fifo"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"

awslocal sqs create-queue --queue-name "$DLQ" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600

DLQ_URL=$(awslocal sqs get-queue-url --queue-name "$DLQ" --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

REDRIVE_POLICY="{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"${MAX_RECEIVE_COUNT}\\\"}"
awslocal sqs create-queue --queue-name "$INPUT_QUEUE" \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"${REDRIVE_POLICY}\"}"

awslocal sqs create-queue --queue-name "$EVENTS_QUEUE" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "SQS queues ready: $INPUT_QUEUE -> $DLQ (maxReceiveCount=$MAX_RECEIVE_COUNT), $EVENTS_QUEUE"
