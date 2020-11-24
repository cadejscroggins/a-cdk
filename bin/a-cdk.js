#!/usr/bin/env node
/* eslint-disable no-console */

const cdk = require('@aws-cdk/core');
const ACdkStack = require('../lib/stacks/a-cdk.js');
const formatResourceId = require('../lib/utilities/format-resource-id');

const app = new cdk.App();
const env = app.node.tryGetContext('env');
const namespace = app.node.tryGetContext('namespace');

if (!env) {
  console.error('Please specify an environment! (via "env" context)');
  process.exit(1);
}

if (!namespace) {
  console.error('Please specify a namespace! (via "namespace" context)');
  process.exit(1);
}

new ACdkStack(app, formatResourceId(namespace, env));
