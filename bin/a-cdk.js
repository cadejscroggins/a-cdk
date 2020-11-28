#!/usr/bin/env node

/* eslint-disable no-console */

const cdk = require('@aws-cdk/core');
const deepmerge = require('deepmerge');
const fs = require('fs');
const path = require('path');
const ACdkStack = require('../lib/stacks/a-cdk.js');
const formatResourceId = require('../lib/utilities/format-resource-id');

const env = process.env.ENV;
const allContextFile = path.join(process.cwd(), `cdk.context.all.json`);
const envContextFile = path.join(process.cwd(), `cdk.context.${env}.json`);

const app = new cdk.App({
  context: deepmerge(
    fs.existsSync(allContextFile)
      ? JSON.parse(fs.readFileSync(allContextFile, 'utf8'))
      : {},
    fs.existsSync(envContextFile)
      ? JSON.parse(fs.readFileSync(envContextFile, 'utf8'))
      : {}
  ),
});

const namespace = app.node.tryGetContext('namespace');

if (!env) {
  console.error('Please specify an env! (via "ENV" environment variable)');
  process.exit(1);
}

if (!namespace) {
  console.error('Please specify a namespace! (via "namespace" context)');
  process.exit(1);
}

new ACdkStack(app, formatResourceId(namespace, env));
