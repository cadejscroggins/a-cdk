const appsync = require('@aws-cdk/aws-appsync');
const cdk = require('@aws-cdk/core');
const changeCase = require('change-case');
const cognito = require('@aws-cdk/aws-cognito');
const dynamodb = require('@aws-cdk/aws-dynamodb');
const fs = require('fs');
const iam = require('@aws-cdk/aws-iam');
const lambda = require('@aws-cdk/aws-lambda');
const formatResourceName = require('./format-resource-name');

const DATA_SOURCE_TYPE_DYNAMODB = 'dynamodb';
const DATA_SOURCE_TYPE_NONE = 'none';

const MAPPING_TEMPLATE_REQUEST_KEY = 'req';
const MAPPING_TEMPLATE_RESPONSE_KEY = 'res';
const MAPPING_TEMPLATE_SEQUENCE_KEY = 'seq';
const MAPPING_TEMPLATE_RESPONSE_DEFAULT = '$util.toJson($ctx.result)';

const COGNITO_PRE_SIGNUP_TRIGGER = 'cognito-pre-signup-trigger';

const CWD = process.cwd();
const DATABASES_DYNAMODB_DIR = `${CWD}/src/databases/dynamodb`;
const LAMBDAS_DIR = `${CWD}/src/lambdas`;
const RESOLVERS_DIR = `${CWD}/src/graphql/resolvers`;
const RESOLVER_FUNCTIONS_DIR = `${CWD}/src/graphql/resolvers/functions`;
const SCHEMA_DEFINITION_FILE = `${CWD}/src/graphql/schema.graphql`;

class ACdkStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const dynamodbTables = this.createDynamodbTables();
    const lambdas = this.createLambdas();
    const api = this.createApi({ dynamodbTables });
    const userPool = this.createUserPool({ lambdas });
    const userPoolClient = this.createUserPoolClient({ userPool });

    const identityPool = this.createIdentityPool({
      api,
      userPool,
      userPoolClient,
    });

    this.createOutputs({
      apiAuthenticationType: 'AWS_IAM',
      apiGraphqlEndpoint: api.graphqlUrl,
      apiRegion: this.region,
      authIdentityPoolId: identityPool.ref,
      authMandatorySignIn: false,
      authRegion: this.region,
      authUserPoolId: userPool.userPoolId,
      authUserPoolWebClientId: userPoolClient.userPoolClientId,
    });
  }

  createApi({ dynamodbTables }) {
    const apiResourceName = formatResourceName(this.artifactId, 'Api');

    const api = new appsync.GraphqlApi(this, apiResourceName, {
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.IAM,
        },
      },
      name: apiResourceName,
      schema: appsync.Schema.fromAsset(SCHEMA_DEFINITION_FILE),
    });

    api.addNoneDataSource(formatResourceName(DATA_SOURCE_TYPE_NONE));

    this.createApiResolvers({
      api,
      dynamodbDataSources: this.createApiDynamodbDataSources({
        api,
        dynamodbTables,
      }),
      pipelineFunctions: this.createApiPipelineFunctions({ api }),
    });

    return api;
  }

  createApiDynamodbDataSources({ api, dynamodbTables }) {
    if (!fs.existsSync(DATABASES_DYNAMODB_DIR)) return {};

    return fs.readdirSync(DATABASES_DYNAMODB_DIR).reduce((acc, fileName) => {
      const [tableName] = fileName.split('.');

      const dataSourceResourceName = formatResourceName(
        DATA_SOURCE_TYPE_DYNAMODB,
        tableName
      );

      acc[
        dataSourceResourceName
      ] = api.addDynamoDbDataSource(
        dataSourceResourceName,
        dynamodbTables[formatResourceName(this.artifactId, tableName)],
        { name: dataSourceResourceName }
      );

      return acc;
    }, {});
  }

  createApiPipelineFunctions({ api }) {
    if (!fs.existsSync(RESOLVER_FUNCTIONS_DIR)) return {};

    return Object.entries(
      fs
        .readdirSync(RESOLVER_FUNCTIONS_DIR)
        .reduce((acc, mappingTemplateFile) => {
          const [
            functionName,
            templateType,
            templateDataSourceType,
            templateDataSourceName,
          ] = mappingTemplateFile.split('.');

          const functionResourceName = formatResourceName(functionName);

          const dataSourceResourceName = formatResourceName(
            templateDataSourceType,
            templateDataSourceName
          );

          acc[functionResourceName] = {
            ...acc[functionResourceName],
            dataSourceName:
              templateDataSourceType && templateDataSourceName
                ? dataSourceResourceName
                : DATA_SOURCE_TYPE_NONE,
            [templateType]: fs.readFileSync(
              `${RESOLVER_FUNCTIONS_DIR}/${mappingTemplateFile}`,
              'utf8'
            ),
          };

          return acc;
        }, {})
    ).reduce((acc, [resourceName, conf]) => {
      const pipelineFunction = new appsync.CfnFunctionConfiguration(
        this,
        resourceName,
        {
          apiId: api.apiId,
          dataSourceName: conf.dataSourceName,
          functionVersion: '2018-05-29',
          name: resourceName,
          requestMappingTemplate: conf.req,
          responseMappingTemplate:
            conf.res || MAPPING_TEMPLATE_RESPONSE_DEFAULT,
        }
      );

      pipelineFunction.node.addDependency(api);
      return { ...acc, [resourceName]: pipelineFunction };
    }, {});
  }

  createApiResolvers({ api, dynamodbDataSources, pipelineFunctions }) {
    if (!fs.existsSync(RESOLVERS_DIR)) return {};

    return Object.entries(
      fs
        .readdirSync(RESOLVERS_DIR, { withFileTypes: true })
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

          const mappingTemplateFilePath = `${RESOLVERS_DIR}/${mappingTemplateFile}`;
          const resolverResourceName = formatResourceName(typeName, fieldName);

          const dataSourceResourceName = formatResourceName(
            templateDataSourceType,
            templateDataSourceName
          );

          let dataSource;

          switch (templateDataSourceType) {
            case DATA_SOURCE_TYPE_DYNAMODB: {
              dataSource = dynamodbDataSources[dataSourceResourceName];
              break;
            }

            default: {
              // noop
            }
          }

          let mappingTemplate;

          switch (templateType) {
            case MAPPING_TEMPLATE_SEQUENCE_KEY: {
              mappingTemplate = JSON.parse(
                fs.readFileSync(mappingTemplateFilePath, 'utf8')
              ).map(
                (functionName) =>
                  pipelineFunctions[formatResourceName(functionName)]
                    .attrFunctionId
              );

              break;
            }

            case MAPPING_TEMPLATE_REQUEST_KEY:
            case MAPPING_TEMPLATE_RESPONSE_KEY: {
              mappingTemplate = appsync.MappingTemplate.fromFile(
                mappingTemplateFilePath
              );

              break;
            }

            default: {
              // noop
            }
          }

          acc[resolverResourceName] = {
            ...acc[resolverResourceName],
            dataSource,
            fieldName: changeCase.camelCase(fieldName),
            [templateType]: mappingTemplate,
            typeName: changeCase.pascalCase(typeName),
          };

          return acc;
        }, {})
    ).reduce((acc, [resourceName, conf]) => {
      const resolver = new appsync.Resolver(this, resourceName, {
        api,
        dataSource: conf.dataSource,
        fieldName: conf.fieldName,
        pipelineConfig: conf[MAPPING_TEMPLATE_SEQUENCE_KEY],
        requestMappingTemplate: conf[MAPPING_TEMPLATE_REQUEST_KEY],
        responseMappingTemplate:
          conf[MAPPING_TEMPLATE_RESPONSE_KEY] ||
          appsync.MappingTemplate.fromString(MAPPING_TEMPLATE_RESPONSE_DEFAULT),
        typeName: conf.typeName,
      });

      resolver.node.addDependency(api);
      return { ...acc, [resourceName]: resolver };
    }, {});
  }

  createDynamodbTables() {
    if (!fs.existsSync(DATABASES_DYNAMODB_DIR)) return {};

    return fs.readdirSync(DATABASES_DYNAMODB_DIR).reduce((acc, configFile) => {
      const [tableName] = configFile.split('.');
      const tableResourceName = formatResourceName(this.artifactId, tableName);
      const configFilePath = `${DATABASES_DYNAMODB_DIR}/${configFile}`;
      const config = JSON.parse(String(fs.readFileSync(configFilePath)));

      const table = new dynamodb.Table(this, tableResourceName, {
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
        tableName: tableResourceName,
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

      acc[tableResourceName] = table;
      return acc;
    }, {});
  }

  createIdentityPool({ api, userPool, userPoolClient }) {
    const identityPoolResourceName = formatResourceName(
      this.artifactId,
      'Identities'
    );

    const identityPool = new cognito.CfnIdentityPool(
      this,
      identityPoolResourceName,
      {
        allowUnauthenticatedIdentities: true,
        cognitoIdentityProviders: [
          {
            clientId: userPoolClient.userPoolClientId,
            providerName: userPool.userPoolProviderName,
          },
        ],
        identityPoolName: identityPoolResourceName,
      }
    );

    new cognito.CfnIdentityPoolRoleAttachment(
      this,
      formatResourceName(identityPool.identityPoolName, 'RoleAttachment'),
      {
        identityPoolId: identityPool.ref,
        roles: {
          authenticated: this.createIdentityPoolAuthenticatedRole({
            api,
            identityPool,
          }).roleArn,
          unauthenticated: this.createIdentityPoolUnauthenticatedRole({
            api,
            identityPool,
          }).roleArn,
        },
      }
    );

    return identityPool;
  }

  createIdentityPoolAuthenticatedRole({ api, identityPool }) {
    const authenticatedRole = new iam.Role(
      this,
      formatResourceName(identityPool.identityPoolName, 'AuthenticatedRole'),
      {
        assumedBy: new iam.FederatedPrincipal(
          'cognito-identity.amazonaws.com',
          {
            'ForAnyValue:StringLike': {
              'cognito-identity.amazonaws.com:amr': 'authenticated',
            },
            StringEquals: {
              'cognito-identity.amazonaws.com:aud': identityPool.ref,
            },
          },
          'sts:AssumeRoleWithWebIdentity'
        ),
      }
    );

    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'mobileanalytics:PutEvents',
          'cognito-sync:*',
          'cognito-identity:*',
        ],
        effect: iam.Effect.ALLOW,
        resources: ['*'],
      })
    );

    authenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['appsync:GraphQL'],
        effect: iam.Effect.ALLOW,
        resources: [`${api.arn}/types/*`],
      })
    );

    return authenticatedRole;
  }

  createIdentityPoolUnauthenticatedRole({ api, identityPool }) {
    const unauthenticatedRole = new iam.Role(
      this,
      formatResourceName(identityPool.identityPoolName, 'UnauthenticatedRole'),
      {
        assumedBy: new iam.FederatedPrincipal(
          'cognito-identity.amazonaws.com',
          {
            'ForAnyValue:StringLike': {
              'cognito-identity.amazonaws.com:amr': 'unauthenticated',
            },
            StringEquals: {
              'cognito-identity.amazonaws.com:aud': identityPool.ref,
            },
          },
          'sts:AssumeRoleWithWebIdentity'
        ),
      }
    );

    unauthenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['mobileanalytics:PutEvents', 'cognito-sync:*'],
        effect: iam.Effect.ALLOW,
        resources: ['*'],
      })
    );

    unauthenticatedRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['appsync:GraphQL'],
        effect: iam.Effect.ALLOW,
        resources: [`${api.arn}/types/*`],
      })
    );

    return unauthenticatedRole;
  }

  createLambdas() {
    if (!fs.existsSync(LAMBDAS_DIR)) return {};

    return fs.readdirSync(LAMBDAS_DIR).reduce((acc, f) => {
      const [fileName] = f.split('.');
      const lambdaResourceName = formatResourceName(this.artifactId, fileName);

      return {
        ...acc,
        [lambdaResourceName]: new lambda.Function(this, lambdaResourceName, {
          code: lambda.Code.fromAsset(LAMBDAS_DIR),
          functionName: lambdaResourceName,
          handler: `${lambdaResourceName}.handler`,
          memorySize: 128,
          runtime: lambda.Runtime.NODEJS_12_X,
          timeout: cdk.Duration.seconds(10),
        }),
      };
    }, {});
  }

  createOutputs(outputs) {
    Object.entries(outputs).forEach(
      ([name, value]) => new cdk.CfnOutput(this, name, { value })
    );
  }

  createUserPool({ lambdas }) {
    const userPoolResourceName = formatResourceName(this.artifactId, 'Users');

    return new cognito.UserPool(this, userPoolResourceName, {
      lambdaTriggers: { preSignUp: lambdas[COGNITO_PRE_SIGNUP_TRIGGER] },
      userPoolName: userPoolResourceName,
    });
  }

  createUserPoolClient({ userPool }) {
    const userPoolClientResourceName = formatResourceName(
      this.artifactId,
      'WebClient'
    );

    return new cognito.UserPoolClient(this, userPoolClientResourceName, {
      userPool,
      userPoolClientName: userPoolClientResourceName,
    });
  }
}

module.exports = ACdkStack;
