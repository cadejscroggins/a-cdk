# a-cdk

> A serverless AWS CDK starter.

## SES Notes

### [Verify email identity](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/verify-email-addresses-procedure.html)

```shell script
aws ses verify-email-identity --email-address sender@example.com
```

### [Verify domain identity](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/verify-domain-procedure.html)

```shell script
aws ses verify-domain-identity --domain example.com
```

| Name                    | Type | Value             |
| ----------------------- | ---- | ----------------- |
| \_amazonses.example.com | TXT  | VerificationToken |

### [Set up DMARC](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/send-email-authentication-dmarc.html)

| Name                | Type | Value                 |
| ------------------- | ---- | --------------------- |
| \_dmarc.example.com | TXT  | v=DMARC1;p=quarantine |

| Key   | Description                                   | Example                           |
| ----- | --------------------------------------------- | --------------------------------- |
| v     | Protocol version                              | v=DMARC1                          |
| pct   | Percentage of messages subjected to filtering | pct=20                            |
| ruf   | Reporting URI for forensic reports            | ruf=mailto\: authfail@example.com |
| rua   | Reporting URI of aggregate reports            | rua=mailto\: aggrep@example.com   |
| p     | Policy for organizational domain              | p=quarantine                      |
| sp    | Policy for subdomains of the OD               | sp=reject                         |
| adkim | Alignment mode for DKIM                       | adkim=s                           |
| aspf  | Alignment mode for SPF                        | aspf=r                            |

#### Set up SPF

```shell script
aws ses set-identity-mail-from-domain \
  --identity example.com \
  --mail-from-domain mail.example.com
```

| Name             | Type | Value                                    |
| ---------------- | ---- | ---------------------------------------- |
| mail.example.com | MX   | 10 feedback-smtp.us-west-2.amazonses.com |
| mail.example.com | TXT  | v=spf1 include:amazonses.com ~all        |

#### Set up DKIM

```shell script
aws ses get-identity-dkim-attributes --identities example.com
```

| Name                           | Type  | Value                     |
| ------------------------------ | ----- | ------------------------- |
| token1.\_domainkey.example.com | CNAME | token1.dkim.amazonses.com |
| token2.\_domainkey.example.com | CNAME | token2.dkim.amazonses.com |
| token3.\_domainkey.example.com | CNAME | token3.dkim.amazonses.com |

### [Ask to be moved out of the sandbox](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/request-production-access.html?icmpid=docs_ses_console)

```shell script
aws sesv2 put-account-details \
  --production-access-enabled \
  --mail-type TRANSACTIONAL \
  --website-url https://example.com \
  --use-case-description "Use case description" \
  --additional-contact-email-addresses info@example.com \
  --contact-language EN
```

#### `--use-case-description` should answer the following

- How do you plan to build or acquire your mailing list?
- How do you plan to handle bounces and complaints?
- How can recipients opt out of receiving email from you?
- How did you choose the sending rate or sending quota that you specified in
  this request?
