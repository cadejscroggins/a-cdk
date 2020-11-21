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

const MAPPING_TEMPLATE_REQUEST_DEFAULT = 'null';
const MAPPING_TEMPLATE_RESPONSE_DEFAULT = '$util.toJson($ctx.result)';

const AUTHENTICATED = 'authenticated';
const UNAUTHENTICATED = 'unauthenticated';

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

    const lambdas = this.createLambdas();
    const dynamodbTables = this.createDynamodbTables();
    const api = this.createApi({ dynamodbTables });
    const userPool = this.createUserPool({ lambdas });
    const userPoolClient = this.createUserPoolClient({ userPool });
    const identityPool = this.createIdentityPool({ userPool, userPoolClient });

    this.attachAuthPermissions({ api, identityPool });
    this.attachLambdaPermissions({ lambdas, userPool });

    this.createCfnOutputs(
      this.createApiOutputs(api),
      this.createIdentityPoolOutputs(identityPool),
      this.createLambdaOutputs(lambdas),
      this.createUserPoolClientOutputs(userPoolClient),
      this.createUserPoolOutputs(userPool),
    );
  }

  attachAuthPermissions({ api, identityPool }) {
    const authenticatedRole = this.createIdentityPoolRole({
      api,
      identityPool,
      roleType: AUTHENTICATED,
    });

    const roles = { authenticated: authenticatedRole.roleArn };

    if (identityPool.allowUnauthenticatedIdentities) {
      const unauthenticatedRole = this.createIdentityPoolRole({
        api,
        identityPool,
        roleType: UNAUTHENTICATED,
      });

      roles.unauthenticated = unauthenticatedRole.roleArn;
    }

    new cognito.CfnIdentityPoolRoleAttachment(
      this,
      formatResourceName(identityPool.identityPoolName, 'RoleAttachment'),
      { identityPoolId: identityPool.ref, roles }
    );
  }

  attachLambdaPermissions({ lambdas, userPool }) {
    const permissionsConf = this.node.tryGetContext('permissions');

    Object.entries(lambdas).forEach(([name, lambda]) => {
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
        lambda.role.attachInlinePolicy(
          new iam.Policy(
            this,
            formatResourceName(lambda.physicalName, 'policy'),
            { statements }
          )
        );
      }
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

  createApiOutputs(api) {
    return {
      apiArn: api.arn,
      apiAuthenticationType: 'AWS_IAM',
      apiGraphqlEndpoint: api.graphqlUrl,
      apiRegion: this.region,
    };
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
        requestMappingTemplate:
          conf[MAPPING_TEMPLATE_REQUEST_KEY] ||
          appsync.MappingTemplate.fromString(MAPPING_TEMPLATE_REQUEST_DEFAULT),
        responseMappingTemplate:
          conf[MAPPING_TEMPLATE_RESPONSE_KEY] ||
          appsync.MappingTemplate.fromString(MAPPING_TEMPLATE_RESPONSE_DEFAULT),
        typeName: conf.typeName,
      });

      resolver.node.addDependency(api);
      return { ...acc, [resourceName]: resolver };
    }, {});
  }

  createCfnOutputs(...outputs) {
    Object.entries(Object.assign(...outputs)).forEach(
      ([name, value]) => new cdk.CfnOutput(this, name, { value })
    );
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

  createIdentityPool({ userPool, userPoolClient }) {
    const authConf = this.node.tryGetContext('auth');

    const identityPoolResourceName = formatResourceName(
      this.artifactId,
      'Identities'
    );

    return new cognito.CfnIdentityPool(this, identityPoolResourceName, {
      allowUnauthenticatedIdentities: !!authConf?.allowUnauthenticatedIdentities,
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: userPool.userPoolProviderName,
        },
      ],
      identityPoolName: identityPoolResourceName,
    });
  }

  createIdentityPoolOutputs(identityPool) {
    return {
      authIdentityPoolId: identityPool.ref,
      authMandatorySignIn: !identityPool.allowUnauthenticatedIdentities,
    };
  }

  createIdentityPoolRole({ api, identityPool, roleType }) {
    const permissionsConf = this.node.tryGetContext('permissions');
    const rolePermissions = permissionsConf?.auth?.[roleType];
    const apiPermissions = rolePermissions?.api || [];

    const role = new iam.Role(
      this,
      formatResourceName(identityPool.identityPoolName, roleType, 'role'),
      {
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
      }
    );

    if (apiPermissions.length) {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['appsync:GraphQL'],
          effect: iam.Effect.ALLOW,
          resources: apiPermissions.map((p) => `${api.arn}/types/${p}`),
        })
      );
    }

    return role;
  }

  createLambdaOutputs(lambdas) {
    return Object.entries(lambdas)
      .filter(([name, lambda]) => name)
      .reduce(
        (acc, [name, lambda]) => ({
          ...acc,
          [changeCase.camelCase(`lambda-${name}-arn`)]: lambda.functionArn,
        }),
        {}
      );
  }

  createLambdas() {
    return fs.existsSync(LAMBDAS_DIR)
      ? fs.readdirSync(LAMBDAS_DIR).reduce((acc, f) => {
          const [fileName] = f.split('.');

          const lambdaResourceName = formatResourceName(
            this.artifactId,
            fileName
          );

          acc[fileName] = new lambda.Function(this, lambdaResourceName, {
            code: lambda.Code.fromAsset(LAMBDAS_DIR),
            functionName: lambdaResourceName,
            handler: `${fileName}.handler`,
            runtime: lambda.Runtime.NODEJS_12_X,
          });

          return acc;
        }, {})
      : {};
  }

  createUserPool({ lambdas }) {
    const userPoolResourceName = formatResourceName(this.artifactId, 'Users');
    const authConf = this.node.tryGetContext('auth');

    return new cognito.UserPool(this, userPoolResourceName, {
      autoVerify: authConf?.autoVerify,
      customAttributes: Object.entries(authConf?.customAttributes || {}).reduce(
        (acc, [attributeName, attributeConfig]) => ({
          ...acc,
          [attributeName]: new cognito[`${attributeConfig.type}Attribute`](
            attributeConfig
          ),
        }),
        {}
      ),
      lambdaTriggers: {
        preSignUp: lambdas[COGNITO_PRE_SIGNUP_TRIGGER],
      },
      passwordPolicy: authConf?.passwordPolicy,
      selfSignUpEnabled: authConf?.selfSignUpEnabled,
      signInAliases: authConf?.signInAliases,
      standardAttributes: authConf?.standardAttributes,
      userPoolName: userPoolResourceName,
    });
  }

  createUserPoolOutputs(userPool) {
    return {
      authRegion: this.region,
      authUserPoolArn: userPool.userPoolArn,
      authUserPoolId: userPool.userPoolId,
    };
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

  createUserPoolClientOutputs(userPoolClient) {
    return {
      authUserPoolWebClientId: userPoolClient.userPoolClientId,
    };
  }
}

module.exports = ACdkStack;
