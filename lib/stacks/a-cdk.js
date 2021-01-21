/* eslint-disable class-methods-use-this, no-console */

const TerserWebpackPlugin = require('terser-webpack-plugin');
const appsync = require('@aws-cdk/aws-appsync');
const cdk = require('@aws-cdk/core');
const changeCase = require('change-case');
const cognito = require('@aws-cdk/aws-cognito');
const crypto = require('crypto');
const customResources = require('@aws-cdk/custom-resources');
const dynamodb = require('@aws-cdk/aws-dynamodb');
const ec2 = require('@aws-cdk/aws-ec2');
const fs = require('fs');
const fse = require('fs-extra');
const iam = require('@aws-cdk/aws-iam');
const lambda = require('@aws-cdk/aws-lambda');
const logs = require('@aws-cdk/aws-logs');
const path = require('path');
const rds = require('@aws-cdk/aws-rds');
const s3Assets = require('@aws-cdk/aws-s3-assets');
const tmp = require('tmp');
const webpack = require('webpack');
const C = require('../utilities/constants');
const formatResourceId = require('../utilities/format-resource-id');

class ACdkStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    (async () => {
      const lambdas = await this.createLambdas();
      const dynamodbTables = this.createDynamodbTables();
      const postgresCluster = await this.createPostgresCluster();
      const api = this.createApi({ dynamodbTables, lambdas, postgresCluster });
      const userPool = this.createUserPool({ lambdas });
      const userPoolClient = this.createUserPoolClient({ userPool });

      const identityPool = this.createIdentityPool({
        userPool,
        userPoolClient,
      });

      this.attachAuthPermissions({ api, identityPool });
      this.attachLambdaPermissions({ lambdas, postgresCluster, userPool });

      this.createCfnOutputs(
        this.createApiOutputs(api),
        this.createIdentityPoolOutputs(identityPool),
        this.createUserPoolClientOutputs(userPoolClient),
        this.createUserPoolOutputs(userPool)
      );
    })();
  }

  attachAuthPermissions({ api, identityPool }) {
    const authenticatedRole = this.createIdentityPoolRole({
      api,
      identityPool,
      roleType: C.AUTH_ROLE.AUTHENTICATED,
    });

    const roles = { authenticated: authenticatedRole.roleArn };

    if (identityPool.allowUnauthenticatedIdentities) {
      const unauthenticatedRole = this.createIdentityPoolRole({
        api,
        identityPool,
        roleType: C.AUTH_ROLE.UNAUTHENTICATED,
      });

      roles.unauthenticated = unauthenticatedRole.roleArn;
    }

    new cognito.CfnIdentityPoolRoleAttachment(
      this,
      formatResourceId(
        identityPool.identityPoolName,
        C.ID_PART.ROLE_ATTACHMENT
      ),
      { identityPoolId: identityPool.ref, roles }
    );
  }

  attachLambdaPermissions({ lambdas, postgresCluster, userPool }) {
    const permissionsConf = this.node.tryGetContext(C.CONTEXT_KEY.PERMISSIONS);

    Object.entries(lambdas).forEach(([name, lambdaResource]) => {
      const lambdaActions = permissionsConf?.lambdas?.[name];
      const lambdaAuthActions = lambdaActions?.auth || [];
      const lambdaPostgresActions = lambdaActions?.databases?.postgres || [];
      const lambdaSesActions = lambdaActions?.ses || [];
      const statements = [];

      if (lambdaAuthActions.length) {
        statements.push(
          new iam.PolicyStatement({
            actions: lambdaAuthActions.map(
              (a) => `${C.ACTION_PREFIX.COGNITO_IDP}${a}`
            ),
            resources: [userPool.userPoolArn],
          })
        );
      }

      if (lambdaPostgresActions.length) {
        statements.push(
          new iam.PolicyStatement({
            actions: lambdaPostgresActions.map(
              (a) => `${C.ACTION_PREFIX.RDS_DATA}${a}`
            ),
            resources: [postgresCluster.clusterArn],
          })
        );

        statements.push(
          new iam.PolicyStatement({
            actions: [C.ACTION.GET_SECRET_VALUE, C.ACTION.DESCRIBE_SECRET].map(
              (a) => `${C.ACTION_PREFIX.SECRETSMANAGER}${a}`
            ),
            resources: [postgresCluster.secret.secretArn],
          })
        );

        lambdaResource.addEnvironment(
          C.ENV_VAR_KEY.PG_CLUSTER_ARN,
          postgresCluster.clusterArn
        );

        lambdaResource.addEnvironment(
          C.ENV_VAR_KEY.PG_CLUSTER_DB_NAME,
          postgresCluster.defaultDatabaseName
        );

        lambdaResource.addEnvironment(
          C.ENV_VAR_KEY.PG_CLUSTER_SECRET_ARN,
          postgresCluster.secret.secretArn
        );
      }

      if (lambdaSesActions.length) {
        statements.push(
          new iam.PolicyStatement({
            actions: lambdaSesActions.map((a) => `${C.ACTION_PREFIX.SES}${a}`),
            resources: ['*'],
          })
        );
      }

      if (statements.length) {
        lambdaResource.role.attachInlinePolicy(
          new iam.Policy(
            this,
            formatResourceId(lambdaResource.physicalName, C.ID_PART.POLICY),
            { statements }
          )
        );
      }
    });
  }

  createApi({ dynamodbTables, lambdas, postgresCluster }) {
    const apiId = formatResourceId(this.artifactId, C.ID_PART.API);

    const noneDataSourceId = formatResourceId(
      C.DATA_SOURCE_TYPE.NONE,
      C.ID_PART.DATA_SOURCE
    );

    const api = new appsync.GraphqlApi(this, apiId, {
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.IAM,
        },
      },
      name: apiId,
      schema: appsync.Schema.fromAsset(C.PATH.SCHEMA_DEFINITION_FILE),
    });

    const noneDataSource = api.addNoneDataSource(noneDataSourceId);

    const dynamodbDataSources = this.createApiDynamodbDataSources({
      api,
      dynamodbTables,
    });

    const lambdaDataSources = this.createApiLambdaDataSources({
      api,
      lambdas,
    });

    const postgresDataSource = this.createApiPostgresDataSource({
      api,
      postgresCluster,
    });

    this.createApiResolvers({
      api,
      dynamodbDataSources,
      lambdaDataSources,
      noneDataSource,
      pipelineFunctions: this.createApiPipelineFunctions({
        api,
        dynamodbDataSources,
        lambdaDataSources,
        noneDataSource,
        postgresDataSource,
      }),
      postgresDataSource,
    });

    api.node.defaultChild.overrideLogicalId(apiId);
    noneDataSource.node.defaultChild.overrideLogicalId(noneDataSourceId);

    return api;
  }

  createApiDynamodbDataSources({ api, dynamodbTables }) {
    if (!fs.existsSync(C.PATH.DATABASES_DDB_TABLES_DIR)) return {};

    return fs
      .readdirSync(C.PATH.DATABASES_DDB_TABLES_DIR)
      .reduce((acc, fileName) => {
        const [tableName] = fileName.split('.');

        const dataSourceId = formatResourceId(
          C.ID_PART.DYNAMODB,
          tableName,
          C.ID_PART.DATA_SOURCE
        );

        acc[dataSourceId] = api.addDynamoDbDataSource(
          dataSourceId,
          dynamodbTables[formatResourceId(this.artifactId, tableName)],
          { name: dataSourceId }
        );

        acc[dataSourceId].node.defaultChild.overrideLogicalId(dataSourceId);

        return acc;
      }, {});
  }

  createApiLambdaDataSources({ api, lambdas }) {
    return Object.entries(lambdas).reduce(
      (acc, [lambdaName, lambdaResource]) => {
        if (Object.values(C.AUTH_TRIGGER).includes(lambdaName)) return acc;

        const dataSourceId = formatResourceId(
          C.ID_PART.LAMBDA,
          lambdaName,
          C.ID_PART.DATA_SOURCE
        );

        acc[dataSourceId] = api.addLambdaDataSource(
          dataSourceId,
          lambdaResource,
          { name: dataSourceId }
        );

        acc[dataSourceId].node.defaultChild.overrideLogicalId(dataSourceId);

        return acc;
      },
      {}
    );
  }

  createApiOutputs(api) {
    return {
      apiAuthenticationType: 'AWS_IAM',
      apiGraphqlEndpoint: api.graphqlUrl,
      apiRegion: this.region,
    };
  }

  createApiPipelineFunctions({
    api,
    dynamodbDataSources,
    lambdaDataSources,
    noneDataSource,
    postgresDataSource,
  }) {
    if (!fs.existsSync(C.PATH.RESOLVER_FUNCTIONS_DIR)) return {};

    return Object.entries(
      fs
        .readdirSync(C.PATH.RESOLVER_FUNCTIONS_DIR)
        .reduce((acc, mappingTemplateFile) => {
          const [
            functionName,
            templateType,
            templateDataSourceType,
            templateDataSourceName,
          ] = mappingTemplateFile.split('.');

          const functionId = formatResourceId(functionName);

          acc[functionId] = {
            ...acc[functionId],
            dataSource: this.getApiDataSourceFromTypeAndName({
              dynamodbDataSources,
              lambdaDataSources,
              noneDataSource,
              postgresDataSource,
              templateDataSourceName,
              templateDataSourceType,
            }),
            [templateType]: appsync.MappingTemplate.fromFile(
              `${C.PATH.RESOLVER_FUNCTIONS_DIR}/${mappingTemplateFile}`
            ),
          };

          return acc;
        }, {})
    ).reduce((acc, [resourceId, conf]) => {
      const pipelineFunction = new appsync.AppsyncFunction(this, resourceId, {
        api,
        dataSource: conf.dataSource,
        name: resourceId,
        requestMappingTemplate: conf.req,
        responseMappingTemplate:
          conf.res ||
          appsync.MappingTemplate.fromString(
            C.MAPPING_TEMPLATE_DEFAULT.RESPONSE
          ),
      });

      pipelineFunction.node.addDependency(api);
      return { ...acc, [resourceId]: pipelineFunction };
    }, {});
  }

  createApiPostgresDataSource({ api, postgresCluster }) {
    if (!fs.existsSync(C.PATH.DATABASES_PG_MIGRATIONS_DIR)) return null;

    const dataSourceId = formatResourceId(
      C.ID_PART.POSTGRES,
      C.ID_PART.DATA_SOURCE
    );

    const postgresDataSource = api.addRdsDataSource(
      dataSourceId,
      postgresCluster,
      postgresCluster.secret,
      { name: dataSourceId }
    );

    postgresDataSource.node.defaultChild.overrideLogicalId(dataSourceId);

    return postgresDataSource;
  }

  createApiResolvers({
    api,
    dynamodbDataSources,
    lambdaDataSources,
    noneDataSource,
    pipelineFunctions,
    postgresDataSource,
  }) {
    if (!fs.existsSync(C.PATH.RESOLVERS_DIR)) return {};

    return Object.entries(
      fs
        .readdirSync(C.PATH.RESOLVERS_DIR, { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => f.name)
        .reduce((acc, mappingTemplateFile) => {
          const [
            typeName,
            fieldName,
            templateType,
            templateDataSourceType,
            templateDataSourceName,
          ] = mappingTemplateFile.split('.');

          const mappingTemplateFilePath = `${C.PATH.RESOLVERS_DIR}/${mappingTemplateFile}`;
          const resolverId = formatResourceId(typeName, fieldName);
          let mappingTemplate;

          switch (templateType) {
            case C.MAPPING_TEMPLATE_KEY.SEQUENCE: {
              mappingTemplate = JSON.parse(
                fs.readFileSync(mappingTemplateFilePath, 'utf8')
              ).map(
                (functionName) =>
                  pipelineFunctions[formatResourceId(functionName)]
              );

              break;
            }

            case C.MAPPING_TEMPLATE_KEY.REQUEST:
            case C.MAPPING_TEMPLATE_KEY.RESPONSE: {
              mappingTemplate = appsync.MappingTemplate.fromFile(
                mappingTemplateFilePath
              );

              break;
            }

            default: {
              // noop
            }
          }

          acc[resolverId] = {
            ...acc[resolverId],
            dataSource: this.getApiDataSourceFromTypeAndName({
              dynamodbDataSources,
              lambdaDataSources,
              noneDataSource,
              postgresDataSource,
              templateDataSourceName,
              templateDataSourceType,
            }),
            fieldName: changeCase.camelCase(fieldName),
            [templateType]: mappingTemplate,
            typeName: changeCase.pascalCase(typeName),
          };

          return acc;
        }, {})
    ).reduce((acc, [Id, conf]) => {
      const resolver = new appsync.Resolver(this, Id, {
        api,
        dataSource: conf.dataSource,
        fieldName: conf.fieldName,
        pipelineConfig: conf[C.MAPPING_TEMPLATE_KEY.SEQUENCE],
        requestMappingTemplate:
          conf[C.MAPPING_TEMPLATE_KEY.REQUEST] ||
          appsync.MappingTemplate.fromString(
            C.MAPPING_TEMPLATE_DEFAULT.REQUEST
          ),
        responseMappingTemplate:
          conf[C.MAPPING_TEMPLATE_KEY.RESPONSE] ||
          appsync.MappingTemplate.fromString(
            C.MAPPING_TEMPLATE_DEFAULT.RESPONSE
          ),
        typeName: conf.typeName,
      });

      resolver.node.addDependency(api);
      return { ...acc, [Id]: resolver };
    }, {});
  }

  async createPostgresCluster() {
    if (!fs.existsSync(C.PATH.DATABASES_PG_MIGRATIONS_DIR)) return null;

    const postgresConf = this.node.tryGetContext(C.CONTEXT_KEY.DATABASES)
      ?.postgres;

    const databaseId = formatResourceId(
      this.node.tryGetContext(C.CONTEXT_KEY.NAMESPACE)
    );

    const clusterId = formatResourceId(
      this.artifactId,
      C.ID_PART.POSTGRES,
      C.ID_PART.CLUSTER
    );

    const vpcId = formatResourceId(clusterId, C.ID_PART.VPC);

    const postgresCluster = new rds.ServerlessCluster(this, clusterId, {
      clusterIdentifier: changeCase.paramCase(clusterId),
      defaultDatabaseName: databaseId,
      enableDataApi: true,
      engine: rds.DatabaseClusterEngine.AURORA_POSTGRESQL,
      parameterGroup: rds.ParameterGroup.fromParameterGroupName(
        this,
        C.ID_PART.PARAMETER_GROUP,
        'default.aurora-postgresql10'
      ),
      scaling: {
        autoPause: cdk.Duration.minutes(postgresConf?.autoPause || 5),
        maxCapacity:
          rds.AuroraCapacityUnit[`ACU_${postgresConf?.maxCapacity || 2}`],
        minCapacity:
          rds.AuroraCapacityUnit[`ACU_${postgresConf?.minCapacity || 2}`],
      },
      vpc: new ec2.Vpc(this, vpcId),
    });

    // for easy access
    postgresCluster.defaultDatabaseName = databaseId;

    await this.createPostgresMigrationsCustomResource({ postgresCluster });

    return postgresCluster;
  }

  async createPostgresMigrationsCustomResource({ postgresCluster }) {
    const lambdaId = formatResourceId(
      this.artifactId,
      C.ID_PART.POSTGRES,
      C.ID_PART.MIGRATIONS
    );

    const postgresMigrationsLambda = new lambda.Function(this, lambdaId, {
      code: await this.createLambdaCodeAsset({
        assets: [C.PATH.DATABASES_PG_MIGRATIONS_DIR],
        entry: C.PATH.DATABASES_PG_MIGRATIONS_LAMBDA,
        lambdaId,
      }),
      environment: {
        [C.ENV_VAR_KEY.PG_CLUSTER_ARN]: postgresCluster.clusterArn,
        [C.ENV_VAR_KEY.PG_CLUSTER_DB_NAME]: postgresCluster.defaultDatabaseName,
        [C.ENV_VAR_KEY.PG_CLUSTER_MIGRATIONS_TABLE_NAME]:
          C.TABLE_NAME.A_CDK_MIGRATIONS,
        [C.ENV_VAR_KEY.PG_CLUSTER_SECRET_ARN]: postgresCluster.secret.secretArn,
      },
      functionName: lambdaId,
      handler: 'index.handler',
      logRetention: logs.LogRetention.ONE_DAY,
      memorySize: 128,
      retryAttempts: 1,
      runtime: lambda.Runtime.NODEJS_12_X,
      timeout: cdk.Duration.seconds(30),
    });

    postgresCluster.grantDataApiAccess(postgresMigrationsLambda);

    const postgresMigrationsCustomResource = new customResources.Provider(
      this,
      formatResourceId(lambdaId, C.ID_PART.CUSTOM_RESOURCE_PROVIDER),
      {
        logRetention: logs.RetentionDays.ONE_DAY,
        onEventHandler: postgresMigrationsLambda,
      }
    );

    // if there are new migrations, this hash will change/trigger the cr update
    const migrationsHash = crypto
      .createHash('md5')
      .update(fs.readdirSync(C.PATH.DATABASES_PG_MIGRATIONS_DIR).join(''))
      .digest('hex');

    new cdk.CustomResource(
      this,
      formatResourceId(lambdaId, C.ID_PART.CUSTOM_RESOURCE),
      {
        properties: { migrationsHash },
        serviceToken: postgresMigrationsCustomResource.serviceToken,
      }
    );

    postgresMigrationsLambda.node.defaultChild.overrideLogicalId(lambdaId);

    postgresMigrationsLambda.role.node.defaultChild.overrideLogicalId(
      formatResourceId(lambdaId, C.ID_PART.SERVICE_ROLE)
    );

    return postgresMigrationsCustomResource;
  }

  createCfnOutputs(...outputs) {
    Object.entries(Object.assign(...outputs)).forEach(
      ([name, value]) => new cdk.CfnOutput(this, name, { value })
    );
  }

  createDynamodbTables() {
    if (!fs.existsSync(C.PATH.DATABASES_DDB_TABLES_DIR)) return {};

    return fs
      .readdirSync(C.PATH.DATABASES_DDB_TABLES_DIR)
      .reduce((acc, configFile) => {
        const [tableName] = configFile.split('.');
        const tableId = formatResourceId(this.artifactId, tableName);
        const configFilePath = `${C.PATH.DATABASES_DDB_TABLES_DIR}/${configFile}`;
        const config = JSON.parse(String(fs.readFileSync(configFilePath)));

        const table = new dynamodb.Table(this, tableId, {
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          partitionKey: {
            name: config.KeyAttributes.PartitionKey.AttributeName,
            type: config.KeyAttributes.PartitionKey.AttributeType,
          },
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          sortKey: config.KeyAttributes.SortKey
            ? {
                name: config.KeyAttributes.SortKey.AttributeName,
                type: config.KeyAttributes.SortKey.AttributeType,
              }
            : undefined,
          tableName: tableId,
        });

        (config.GlobalSecondaryIndexes || []).forEach((gsi) => {
          table.addGlobalSecondaryIndex({
            indexName: gsi.IndexName,
            partitionKey: {
              name: gsi.KeyAttributes.PartitionKey.AttributeName,
              type: gsi.KeyAttributes.PartitionKey.AttributeType,
            },
            sortKey: gsi.KeyAttributes.SortKey
              ? {
                  name: gsi.KeyAttributes.SortKey.AttributeName,
                  type: gsi.KeyAttributes.SortKey.AttributeType,
                }
              : undefined,
          });
        });

        acc[tableId] = table;
        return acc;
      }, {});
  }

  createIdentityPool({ userPool, userPoolClient }) {
    const authConf = this.node.tryGetContext(C.CONTEXT_KEY.AUTH);

    const identityPoolId = formatResourceId(
      this.artifactId,
      C.ID_PART.IDENTITIES
    );

    return new cognito.CfnIdentityPool(this, identityPoolId, {
      allowUnauthenticatedIdentities: !!authConf?.allowUnauthenticatedIdentities,
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: userPool.userPoolProviderName,
        },
      ],
      identityPoolName: identityPoolId,
    });
  }

  createIdentityPoolOutputs(identityPool) {
    return {
      authIdentityPoolId: identityPool.ref,
      authMandatorySignIn: !identityPool.allowUnauthenticatedIdentities,
    };
  }

  createIdentityPoolRole({ api, identityPool, roleType }) {
    const permissionsConf = this.node.tryGetContext(C.CONTEXT_KEY.PERMISSIONS);
    const rolePermissions = permissionsConf?.auth?.[roleType];
    const apiPermissions = rolePermissions?.api || [];

    const roleId = formatResourceId(
      identityPool.identityPoolName,
      roleType,
      'role'
    );

    const role = new iam.Role(this, roleId, {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': roleType,
          },
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': identityPool.ref,
          },
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
    });

    if (apiPermissions.length) {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['appsync:GraphQL'],
          effect: iam.Effect.ALLOW,
          resources: apiPermissions.map((p) => `${api.arn}/types/${p}`),
        })
      );
    }

    role.node.defaultChild.overrideLogicalId(roleId);

    return role;
  }

  createLambdaCodeAsset({ assets = [], entry, lambdaId }) {
    const lambdaAssetId = formatResourceId(lambdaId, C.ID_PART.LAMBDA_ASSET);
    const tmpLambdaAssetDir = tmp.dirSync().name;

    assets.forEach((a) =>
      fse.copySync(a, path.join(tmpLambdaAssetDir, path.basename(a)))
    );

    return new Promise((resolve, reject) => {
      webpack(
        {
          entry,
          externals: { 'aws-sdk': 'aws-sdk' },
          mode: 'production',
          module: {
            rules: [
              {
                exclude: /(node_modules)/,
                test: /\.js$/,
                use: {
                  loader: 'babel-loader',
                  options: {
                    presets: ['@babel/preset-env'],
                  },
                },
              },
            ],
          },
          optimization: {
            minimize: true,
            minimizer: [new TerserWebpackPlugin({ extractComments: false })],
          },
          output: {
            filename: path.basename(entry),
            libraryTarget: 'commonjs2',
            path: tmpLambdaAssetDir,
          },
          target: 'node',
        },
        (err, stats) => {
          if (err || stats.hasErrors()) {
            console.error(`${lambdaAssetId} build error:`);
            console.error(err || stats.toString());
            return reject();
          }

          const lambdaAsset = new s3Assets.Asset(this, lambdaAssetId, {
            path: tmpLambdaAssetDir,
          });

          const lambdaCode = lambda.Code.fromBucket(
            lambdaAsset.bucket,
            lambdaAsset.s3ObjectKey
          );

          return resolve(lambdaCode);
        }
      );
    });
  }

  async createLambdas() {
    if (!fs.existsSync(C.PATH.LAMBDAS_DIR)) return {};

    const lambdasConf = this.node.tryGetContext(C.CONTEXT_KEY.LAMBDAS);
    const lambdaDirs = fs.readdirSync(C.PATH.LAMBDAS_DIR);

    const lambdaAssets = await Promise.all(
      lambdaDirs.map((name) =>
        this.createLambdaCodeAsset({
          entry: `${C.PATH.LAMBDAS_DIR}/${name}/index.js`,
          lambdaId: formatResourceId(this.artifactId, name),
        })
      )
    );

    return lambdaDirs.reduce((acc, name, i) => {
      const lambdaConf = lambdasConf?.[name];
      const lambdaId = formatResourceId(this.artifactId, name);
      const roleId = formatResourceId(lambdaId, C.ID_PART.SERVICE_ROLE);

      acc[name] = new lambda.Function(this, lambdaId, {
        code: lambdaAssets[i],
        functionName: lambdaId,
        handler: 'index.handler',
        memorySize: lambdaConf?.memorySize || 128,
        retryAttempts: lambdaConf?.retryAttempts || 0,
        runtime: lambda.Runtime.NODEJS_12_X,
        timeout: cdk.Duration.seconds(lambdaConf?.timeout || 3),
      });

      acc[name].node.defaultChild.overrideLogicalId(lambdaId);
      acc[name].role.node.defaultChild.overrideLogicalId(roleId);

      return acc;
    }, {});
  }

  createUserPool({ lambdas }) {
    const authConf = this.node.tryGetContext(C.CONTEXT_KEY.AUTH);
    const userPoolId = formatResourceId(this.artifactId, C.ID_PART.USERS);

    const userPoolCustomAttributes = Object.entries(
      authConf?.customAttributes || {}
    ).reduce(
      (acc, [attributeName, attributeConfig]) => ({
        ...acc,
        [attributeName]: new cognito[`${attributeConfig.type}Attribute`](
          attributeConfig
        ),
      }),
      {}
    );

    const userPool = new cognito.UserPool(this, userPoolId, {
      autoVerify: authConf?.autoVerify,
      customAttributes: userPoolCustomAttributes,
      lambdaTriggers: {
        customMessage: lambdas[C.AUTH_TRIGGER.CUSTOM_MESSAGE],
        preSignUp: lambdas[C.AUTH_TRIGGER.PRE_SIGNUP],
      },
      passwordPolicy: authConf?.passwordPolicy,
      selfSignUpEnabled: authConf?.selfSignUpEnabled,
      signInAliases: authConf?.signInAliases,
      standardAttributes: authConf?.standardAttributes,
      userPoolName: userPoolId,
    });

    if (authConf.emailConfiguration) {
      userPool.node.defaultChild.emailConfiguration = {
        emailSendingAccount: 'DEVELOPER',
        from: `${authConf.emailConfiguration.fromName} <${authConf.emailConfiguration.fromAddress}>`,
        sourceArn: `arn:aws:ses:${this.region}:${this.account}:identity/${authConf.emailConfiguration.fromAddress}`,
      };
    }

    userPool.node.defaultChild.overrideLogicalId(userPoolId);

    return userPool;
  }

  createUserPoolOutputs(userPool) {
    return {
      authRegion: this.region,
      authUserPoolId: userPool.userPoolId,
    };
  }

  createUserPoolClient({ userPool }) {
    const userPoolClientId = formatResourceId(
      this.artifactId,
      C.ID_PART.WEB_CLIENT
    );

    const userPoolClient = new cognito.UserPoolClient(this, userPoolClientId, {
      userPool,
      userPoolClientName: userPoolClientId,
    });

    userPoolClient.node.defaultChild.overrideLogicalId(userPoolClientId);

    return userPoolClient;
  }

  createUserPoolClientOutputs(userPoolClient) {
    return {
      authUserPoolWebClientId: userPoolClient.userPoolClientId,
    };
  }

  getApiDataSourceFromTypeAndName({
    dynamodbDataSources,
    lambdaDataSources,
    noneDataSource,
    postgresDataSource,
    templateDataSourceName,
    templateDataSourceType,
  }) {
    let dataSource;

    switch (templateDataSourceType) {
      case C.DATA_SOURCE_TYPE.DYNAMODB: {
        dataSource =
          dynamodbDataSources[
            formatResourceId(
              C.ID_PART.DYNAMODB,
              templateDataSourceName,
              C.ID_PART.DATA_SOURCE
            )
          ];

        break;
      }

      case C.DATA_SOURCE_TYPE.LAMBDA: {
        dataSource =
          lambdaDataSources[
            formatResourceId(
              C.ID_PART.LAMBDA,
              templateDataSourceName,
              C.ID_PART.DATA_SOURCE
            )
          ];

        break;
      }

      case C.DATA_SOURCE_TYPE.POSTGRES: {
        dataSource = postgresDataSource;
        break;
      }

      default: {
        dataSource = noneDataSource;
      }
    }

    return dataSource;
  }
}

module.exports = ACdkStack;
