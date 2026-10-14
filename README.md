# n8n-nodes-refractr

This is an n8n community node for [Refractr](https://refractr.io), a document extraction API. Give it an invoice, delivery note, bill of lading or any other document, as a file, scan or text, plus the fields you want, and it returns typed values with a confidence score per field. A field that isn't in the document comes back as `null`, never made up.

The node sends results it's confident about to one output and doubtful ones to a **Needs Review** output, so only those go to a person.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation) · [Operations](#operations) · [Credentials](#credentials) · [Usage](#usage) · [Compatibility](#compatibility) · [Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation, and install `n8n-nodes-refractr`.

## Operations

**Extraction**

- **Extract**: extract fields from a file (PDF, Word, OpenDocument, or a scan or photo) or from text.
- **Get Job**: get the result of an extraction by its job ID.

**Account**

- **Get Credit Balance**: the current balance plus lifetime purchased and used totals.
- **Get Usage**: daily request and credit totals over the last N days.

## Credentials

1. [Sign up](https://refractr.io/signup/) and confirm your email address. Keys only work after that.
2. Create an API key in your [dashboard](https://refractr.io/account/).
3. In n8n, create a **Refractr API** credential and paste the key. Leave Base URL as it is.

Every account gets 100 free extractions per day.

## Usage

### Defining the fields

Add each field with a name and a type: String, Number, Integer, Boolean, Date, or a list of one of those. Descriptive names work best (`invoice_date` beats `d1`). Use dots to nest fields, such as `vendor.name` and `vendor.vat_number`.

For lists of objects, such as invoice line items, set **Schema Definition** to **Using JSON Template** and write a [Refractr template](https://refractr.io/docs/#templates):

```json
{
  "invoice_number": "__str__",
  "total_amount": "__float__",
  "line_items": [{ "description": "__str__", "amount": "__float__" }]
}
```

Dates always come back as `YYYY-MM-DD`, and amounts as bare numbers (`1249.0`, not `"EUR 1,249.00"`).

### Scans and photos (OCR)

With **OCR** set to **Auto**, images are read with OCR. Other files are read from their text layer first, and retried with OCR only when they have none, such as scanned PDFs. The first attempt on a scan fails without being charged, so you only pay for OCR (2 credits instead of 1) when it's needed. Choose **Always** for PDFs that mix text and scanned pages.

### Routing by confidence

With **Route by Confidence** on, the node has two outputs:

- **Confident**: every scored field is at or above the **Confidence Threshold** (default 0.9).
- **Needs Review**: at least one field scored below it, a field listed under **Options > Fields That Must Have a Value** is empty, or the extraction failed while **On Error** is set to continue.

The input file is passed through on both outputs, so a reviewer can open the document. A typical workflow sends the Confident output to your accounting system or a spreadsheet, and Needs Review to Slack, email or a review sheet with `reviewReasons` in the message.

Fields Refractr doesn't score, such as judgment fields (`sentiment`, `category`, `is_…` flags) and text longer than eight words, are ignored when routing.

### Output

With **Simplify** on, each item looks like this:

```json
{
  "data": { "invoice_number": "VV-26-0412", "total": 1756.92, "po_number": null },
  "confidence": { "invoice_number": 0.9612, "total": 0.71, "po_number": 0.98 },
  "needsReview": true,
  "reviewReasons": ["total: confidence 0.71 is below 0.9"],
  "lowConfidenceFields": ["total"],
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "creditsCharged": 1
}
```

Turn Simplify off to get the full API response, including `validation.warnings` and `metadata`, with the same review fields added.

### Large files

An extraction normally waits for its result, up to 30 seconds. For large scans, set **Options > Mode** to **Submit and Poll**. Files can be up to about 7 MB, PDFs up to 20 pages (10 with OCR). See [limits](https://refractr.io/docs/#documents).

### Rate limits

The API allows 60 requests per minute per key. When it's exceeded, the node waits as long as the API asks and retries.

### As an AI agent tool

The node can be used as a tool by n8n's AI Agent, for extracting fields from text.

## Compatibility

Tested with n8n 2.43.5.

## Development

Requires Node.js 24 (n8n's dependencies don't build on Node 25 yet).

```bash
npm install
npm run dev    # starts n8n on http://localhost:5678 with this node loaded
npm test       # builds, then runs the tests in test/ against a mocked API
npm run lint
```

## Resources

- [Refractr API documentation](https://refractr.io/docs/)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## Version history

See [CHANGELOG.md](CHANGELOG.md).
