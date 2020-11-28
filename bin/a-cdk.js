#!/usr/bin/env node

/* eslint-disable no-console */

const cdk = require('@aws-cdk/core');
const deepmerge = require('deepmerge');
const fs = require('fs');
const path = require('path');
const ACdkStack = require('../lib/stacks/a-cdk.js');
const formatResourceId = require('../lib/utilities/format-resource-id');

const env = process.env.ENV;
const contextFile = path.join(process.cwd(), `cdk.context.json`);
const envContextFile = path.join(process.cwd(), `cdk.context.${env}.json`);
let context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));

if (fs.existsSync(envContextFile)) {
  context = deepmerge(
    context,
    JSON.parse(fs.readFileSync(envContextFile, 'utf8'))
  );
}

const app = new cdk.App({ context });

if (!env) {
  console.error('Please specify an env! (via "ENV" environment variable)');
  process.exit(1);
}

if (!context.namespace) {
  console.error('Please specify a namespace! (via "namespace" context)');
  process.exit(1);
}

new ACdkStack(app, formatResourceId(context.namespace, env));
