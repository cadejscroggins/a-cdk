/* eslint-disable class-methods-use-this */

const appsync = require('@aws-cdk/aws-appsync');
const cdk = require('@aws-cdk/core');
const changeCase = require('change-case');
const cognito = require('@aws-cdk/aws-cognito');
const customResources = require('@aws-cdk/custom-resources');
const dynamodb = require('@aws-cdk/aws-dynamodb');
const ec2 = require('@aws-cdk/aws-ec2');
const fs = require('fs');
const iam = require('@aws-cdk/aws-iam');
const lambda = require('@aws-cdk/aws-lambda');
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
      const lambdas = this.createLambdas();
      const dynamodbTables = this.createDynamodbTables();
      const postgresCluster = await this.createPostgresCluster();
      const api = this.createApi({ dynamodbTables, postgresCluster });
      const userPool = this.createUserPool({ lambdas });
      const userPoolClient = this.createUserPoolClient({ userPool });

      const identityPool = this.createIdentityPool({
        userPool,
        userPoolClient,
      });

      this.attachAuthPermissions({ api, identityPool });
      this.attachLambdaPermissions({ lambdas, userPool });

      this.createCfnOutputs(
        this.createApiOutputs(api),
        this.createIdentityPoolOutputs(identityPool),
        this.createLambdaOutputs(lambdas),
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

  attachLambdaPermissions({ lambdas, userPool }) {
    const permissionsConf = this.node.tryGetContext(C.CONTEXT_KEY.PERMISSIONS);

    Object.entries(lambdas).forEach(([name, lambdaResource]) => {
      const lambdaActions = permissionsConf?.lambdas?.[name];
      const lambdaAuthActions = lambdaActions?.auth || [];
      const statements = [];

      if (lambdaAuthActions.length) {
        statements.push(
          new iam.PolicyStatement({
            actions: lambdaAuthActions.map((a) => `cognito-idp:${a}`),
            resources: [userPool.userPoolArn],
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

  createApi({ dynamodbTables, postgresCluster }) {
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

    this.createApiResolvers({
      api,
      dynamodbDataSources: this.createApiDynamodbDataSources({
        api,
        dynamodbTables,
      }),
      pipelineFunctions: this.createApiPipelineFunctions({ api }),
      postgresDataSource: this.createApiPostgresDataSource({
        api,
        postgresCluster,
      }),
    });

    api.node.defaultChild.overrideLogicalId(apiId);
    noneDataSource.node.defaultChild.overrideLogicalId(noneDataSourceId);

    return api;
  }

  createApiDynamodbDataSources({ api, dynamodbTables }) {
    if (!fs.existsSync(C.PATH.DATABASES_DDB_DIR)) return {};

    return fs.readdirSync(C.PATH.DATABASES_DDB_DIR).reduce((acc, fileName) => {
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

  createApiOutputs(api) {
    return {
      apiArn: api.arn,
      apiAuthenticationType: 'AWS_IAM',
      apiGraphqlEndpoint: api.graphqlUrl,
      apiRegion: this.region,
    };
  }

  createApiPipelineFunctions({ api }) {
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

          const dataSourceId = formatResourceId(
            templateDataSourceType,
            templateDataSourceName,
            C.ID_PART.DATA_SOURCE
          );

          acc[functionId] = {
            ...acc[functionId],
            dataSourceName: templateDataSourceType
              ? dataSourceId
              : C.DATA_SOURCE_TYPE.NONE,
            [templateType]: fs.readFileSync(
              `${C.PATH.RESOLVER_FUNCTIONS_DIR}/${mappingTemplateFile}`,
              'utf8'
            ),
          };

          return acc;
        }, {})
    ).reduce((acc, [resourceId, conf]) => {
      const pipelineFunction = new appsync.CfnFunctionConfiguration(
        this,
        resourceId,
        {
          apiId: api.apiId,
          dataSourceName: conf.dataSourceName,
          functionVersion: '2018-05-29',
          name: resourceId,
          requestMappingTemplate: conf.req,
          responseMappingTemplate:
            conf.res || C.MAPPING_TEMPLATE_DEFAULT.RESPONSE,
        }
      );

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

          const dataSourceId = formatResourceId(
            templateDataSourceType,
            templateDataSourceName,
            C.ID_PART.DATA_SOURCE
          );

          let dataSource;

          switch (templateDataSourceType) {
            case C.DATA_SOURCE_TYPE.DYNAMODB: {
              dataSource = dynamodbDataSources[dataSourceId];
              break;
            }

            case C.DATA_SOURCE_TYPE.POSTGRES: {
              dataSource = postgresDataSource;
              break;
            }

            default: {
              // noop
            }
          }

          let mappingTemplate;

          switch (templateType) {
            case C.MAPPING_TEMPLATE_KEY.SEQUENCE: {
              mappingTemplate = JSON.parse(
                fs.readFileSync(mappingTemplateFilePath, 'utf8')
              ).map(
                (functionName) =>
                  pipelineFunctions[formatResourceId(functionName)]
                    .attrFunctionId
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
            dataSource,
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

    const databaseId = formatResourceId(
      this.node.tryGetContext(C.CONTEXT_KEY.NAMESPACE)
    );

    const clusterId = formatResourceId(
      this.artifactId,
      C.ID_PART.POSTGRES,
      C.ID_PART.CLUSTER
    );

    const secretId = formatResourceId(clusterId, C.ID_PART.SECRET);
    const vpcId = formatResourceId(clusterId, C.ID_PART.VPC);

    const parameterGroup = rds.ParameterGroup.fromParameterGroupName(
      this,
      'ParameterGroup',
      'default.aurora-postgresql10'
    );

    const vpc = new ec2.Vpc(this, vpcId);

    const postgresCluster = new rds.ServerlessCluster(this, clusterId, {
      // securityGroups: ...,
      // subnetGroup: ...,
      // vpcSubnets: ...,
      clusterIdentifier: changeCase.paramCase(clusterId),
      defaultDatabaseName: databaseId,
      enableDataApi: true,
      engine: rds.DatabaseClusterEngine.AURORA_POSTGRESQL,
      parameterGroup,
      scaling: { autoPause: cdk.Duration.minutes(5) },
      vpc,
    });

    await this.createPostgresMigrationsCustomResource({ postgresCluster });

    postgresCluster.node.defaultChild.overrideLogicalId(clusterId);
    postgresCluster.secret.node.defaultChild.overrideLogicalId(secretId);
    vpc.node.defaultChild.overrideLogicalId(vpcId);

    return postgresCluster;
  }

  async createPostgresMigrationsCustomResource({ postgresCluster }) {
    const migrationsLambdaId = formatResourceId(
      this.artifactId,
      C.ID_PART.POSTGRES,
      C.ID_PART.MIGRATIONS
    );

    const migrationsLambdaRoleId = formatResourceId(
      migrationsLambdaId,
      C.ID_PART.SERVICE_ROLE
    );

    const migrationsCustomResourceId = formatResourceId(
      migrationsLambdaId,
      C.ID_PART.CUSTOM_RESOURCE
    );

    const postgresMigrationsLambdaAsset = await this.createPostgresMigrationsCustomResourceLambdaAsset();

    const postgresMigrationsLambda = new lambda.Function(
      this,
      migrationsLambdaId,
      {
        code: lambda.Code.fromBucket(
          postgresMigrationsLambdaAsset.bucket,
          postgresMigrationsLambdaAsset.s3ObjectKey
        ),
        environment: {
          clusterArn: postgresCluster.clusterArn,
          secretArn: postgresCluster.secret.secretArn,
        },
        functionName: migrationsLambdaId,
        handler: 'index.handler',
        memorySize: 128,
        runtime: lambda.Runtime.NODEJS_12_X,
        timeout: cdk.Duration.seconds(10),
      }
    );

    postgresCluster.grantDataApiAccess(postgresMigrationsLambda);

    const postgresMigrationsCustomResource = new customResources.Provider(
      this,
      migrationsCustomResourceId,
      {
        onEventHandler: postgresMigrationsLambda,
      }
    );

    postgresMigrationsLambda.node.defaultChild.overrideLogicalId(
      migrationsLambdaId
    );

    postgresMigrationsLambda.role.node.defaultChild.overrideLogicalId(
      migrationsLambdaRoleId
    );

    return postgresMigrationsCustomResource;
  }

  createPostgresMigrationsCustomResourceLambdaAsset() {
    const migrationsLambdaAssetId = formatResourceId(
      this.artifactId,
      C.ID_PART.POSTGRES,
      C.ID_PART.MIGRATIONS,
      C.ID_PART.LAMBDA_ASSET
    );

    const tmpLambdaAssetDir = tmp.dirSync().name;
    const tmpMigrationsAssetDir = `${tmpLambdaAssetDir}/migrations`;

    fs.mkdirSync(tmpMigrationsAssetDir);

    fs.readdirSync(C.PATH.DATABASES_PG_MIGRATIONS_DIR).forEach((asset) =>
      fs.copyFileSync(
        `${C.PATH.DATABASES_PG_MIGRATIONS_DIR}/${asset}`,
        `${tmpMigrationsAssetDir}/${asset}`
      )
    );

    return new Promise((resolve, reject) => {
      webpack(
        {
          entry: C.PATH.DATABASES_PG_MIGRATIONS_LAMBDA,
          externals: { 'aws-sdk': 'aws-sdk' },
          mode: 'development',
          output: {
            filename: 'index.js',
            libraryTarget: 'umd',
            path: tmpLambdaAssetDir,
          },
          target: 'node',
        },
        (err, stats) =>
          err || stats.hasErrors()
            ? reject(err || stats.toJson())
            : resolve(
                new s3Assets.Asset(this, migrationsLambdaAssetId, {
                  path: tmpLambdaAssetDir,
                })
              )
      );
    });
  }

  createCfnOutputs(...outputs) {
    Object.entries(Object.assign(...outputs)).forEach(
      ([name, value]) => new cdk.CfnOutput(this, name, { value })
    );
  }

  createDynamodbTables() {
    if (!fs.existsSync(C.PATH.DATABASES_DDB_DIR)) return {};

    return fs
      .readdirSync(C.PATH.DATABASES_DDB_DIR)
      .reduce((acc, configFile) => {
        const [tableName] = configFile.split('.');
        const tableId = formatResourceId(this.artifactId, tableName);
        const configFilePath = `${C.PATH.DATABASES_DDB_DIR}/${configFile}`;
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

  createLambdaOutputs(lambdas) {
    return Object.entries(lambdas)
      .filter(([name]) => name)
      .reduce(
        (acc, [name, l]) => ({
          ...acc,
          [changeCase.camelCase(`lambda-${name}-arn`)]: l.functionArn,
        }),
        {}
      );
  }

  createLambdas() {
    if (!fs.existsSync(C.PATH.LAMBDAS_DIR)) return {};

    return fs.readdirSync(C.PATH.LAMBDAS_DIR).reduce((acc, name) => {
      const lambdaId = formatResourceId(this.artifactId, name);
      const roleId = formatResourceId(lambdaId, C.ID_PART.SERVICE_ROLE);

      acc[name] = new lambda.Function(this, lambdaId, {
        code: lambda.Code.fromAsset(`${C.PATH.LAMBDAS_DIR}/${name}`),
        functionName: lambdaId,
        handler: 'index.handler',
        runtime: lambda.Runtime.NODEJS_12_X,
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
      authUserPoolArn: userPool.userPoolArn,
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
}

module.exports = ACdkStack;
