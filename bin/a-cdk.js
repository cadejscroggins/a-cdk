#!/usr/bin/env node

const cdk = require('@aws-cdk/core');
const ServerlessStarterStack = require('../lib/a-cdk-stack.js');
const formatResourceName = require('../lib/format-resource-name');

const app = new cdk.App();
const env = app.node.tryGetContext('env');
const namespace = app.node.tryGetContext('namespace');

if (!env) {
  // eslint-disable-next-line no-console
  console.error('Please specify an environment! (via "env" context)');
  process.exit(1);
}

if (!namespace) {
  // eslint-disable-next-line no-console
  console.error('Please specify a namespace! (via "namespace" context)');
  process.exit(1);
}

new ServerlessStarterStack(app, formatResourceName(namespace, env));
