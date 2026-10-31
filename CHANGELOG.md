# Changelog

## 0.2.1

- README: comparison with n8n's Information Extractor, and the free tier corrected to 20 extractions a day (100 with the training opt-in). No changes to the node.

## 0.2.0

- Input: files can come from a URL or a base64 string (or data URL), besides a binary field. Downloaded and decoded files are added to the output as binary field `data`.
- File types are detected from the content. Text and HTML files are sent as text, with HTML turned into plain text.
- Options > PDF Pages: send only some pages of a PDF, such as `1-3, 5` or `1, last`. Images that only removed pages use are left out.
- Options > Shrink Large Images: shrink JPEG and PNG images over 2000 pixels to 2000 pixels before upload, turned upright by their EXIF orientation.
- Files over the size limit get a hint about the option that shrinks them.
- The build bundles the node with esbuild, so the package keeps no runtime dependencies.

## 0.1.1

- Published from GitHub Actions with npm provenance. No changes to the node.

## 0.1.0

First version.

- Extraction > Extract: fields from a file (PDF, Word, OpenDocument, scan or photo) or text, defined as a field list or a JSON template
- OCR Auto mode: images use OCR; other files are retried with OCR only when they have no text layer
- Route by Confidence: Confident and Needs Review outputs, with a threshold and fields that must have a value
- Submit and Poll mode for large files, and Extraction > Get Job
- Account > Get Credit Balance and Get Usage
- Waits and retries when rate limited
