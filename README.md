# a-cdk

> A serverless AWS CDK starter.

## SES Notes

### [Send an email verification request](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/verify-email-addresses-procedure.html):

```shell script
aws ses verify-email-identity --email-address sender@example.com
```

### [Ask to be moved out of the sandbox](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/request-production-access.html?icmpid=docs_ses_console):

```shell script
aws sesv2 put-account-details \
  --production-access-enabled \
  --mail-type TRANSACTIONAL \
  --website-url https://example.com \
  --use-case-description "Use case description" \
  --additional-contact-email-addresses info@example.com \
  --contact-language EN
```

#### `--use-case-description` should answer the following:

- How do you plan to build or acquire your mailing list?
- How do you plan to handle bounces and complaints?
- How can recipients opt out of receiving email from you?
- How did you choose the sending rate or sending quota that you specified in this request?

## TODO Notes

- Automatically configure email templates (cognito/generic).
- [Generate TXT emails from HTML](https://www.npmjs.com/package/html-to-text).
- [Transpile lambdas](https://rollupjs.org/guide/en/#javascript-api).