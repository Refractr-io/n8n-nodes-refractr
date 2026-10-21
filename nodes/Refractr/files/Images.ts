import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';

import { inflate, unfilterRows } from './Compression';

interface Rgba {
	width: number;
	height: number;
	data: Uint8Array;
}

export interface ImageInfo {
	width: number;
	height: number;
	/** The EXIF orientation of a JPEG, 1 to 8. */
	orientation: number;
}

/**
 * Refractr reads images at up to 2000 pixels on the longest side and shrinks larger ones, so
 * anything above that is uploaded and decoded for nothing. Going lower loses fine print.
 */
export const MAX_IMAGE_SIDE = 2000;

const PNG_SIGNATURE = '89504e470d0a1a0a';

/** Channels per pixel for each PNG color type: gray, RGB, palette, gray and alpha, RGBA. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Reads the size of a JPEG or PNG from its header, without decoding it. */
export function imageInfo(data: Buffer): ImageInfo | undefined {
	if (data.length > 24 && data.toString('hex', 0, 8) === PNG_SIGNATURE) {
		return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), orientation: 1 };
	}
	if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;

	let orientation = 1;
	let pos = 2;
	while (pos + 4 <= data.length) {
		if (data[pos] !== 0xff) return undefined;
		const marker = data[pos + 1];
		if (marker === 0xff) {
			pos++;
			continue;
		}
		const length = data.readUInt16BE(pos + 2);
		if (marker === 0xe1 && data.toString('latin1', pos + 4, pos + 10) === 'Exif\0\0') {
			orientation = exifOrientation(data, pos + 10) ?? orientation;
		}
		// Start of frame: every SOFn except DHT (C4), JPG (C8) and DAC (CC).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (pos + 9 > data.length) return undefined;
			return { height: data.readUInt16BE(pos + 5), width: data.readUInt16BE(pos + 7), orientation };
		}
		pos += 2 + length;
	}
	return undefined;
}

function exifOrientation(data: Buffer, tiff: number): number | undefined {
	if (tiff + 8 > data.length) return undefined;
	const little = data.toString('latin1', tiff, tiff + 2) === 'II';
	const u16 = (at: number) => (little ? data.readUInt16LE(at) : data.readUInt16BE(at));
	const u32 = (at: number) => (little ? data.readUInt32LE(at) : data.readUInt32BE(at));
	const ifd = tiff + u32(tiff + 4);
	if (ifd + 2 > data.length) return undefined;
	const count = u16(ifd);
	for (let i = 0; i < count; i++) {
		const entry = ifd + 2 + i * 12;
		if (entry + 12 > data.length) return undefined;
		if (u16(entry) === 0x0112) {
			const value = u16(entry + 8);
			return value >= 1 && value <= 8 ? value : undefined;
		}
	}
	return undefined;
}

/** Decodes a non-interlaced PNG of any color type and bit depth to 8-bit RGBA. */
function decodePng(data: Buffer): Rgba | undefined {
	let pos = 8;
	let header: Buffer | undefined;
	let palette: Buffer | undefined;
	let transparency: Buffer | undefined;
	const chunks: Buffer[] = [];
	while (pos + 8 <= data.length) {
		const length = data.readUInt32BE(pos);
		const type = data.toString('latin1', pos + 4, pos + 8);
		const body = data.subarray(pos + 8, pos + 8 + length);
		if (type === 'IHDR') header = body;
		else if (type === 'PLTE') palette = body;
		else if (type === 'tRNS') transparency = body;
		else if (type === 'IDAT') chunks.push(body);
		else if (type === 'IEND') break;
		pos += 12 + length;
	}
	if (!header || header.length < 13) return undefined;
	const width = header.readUInt32BE(0);
	const height = header.readUInt32BE(4);
	const depth = header[8];
	const colorType = header[9];
	if (header[12] !== 0) return undefined; // Interlaced: rare for scans, so sent as it is.

	const channels = CHANNELS[colorType];
	if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return undefined;
	const bitsPerPixel = channels * depth;
	const rowLength = Math.ceil((width * bitsPerPixel) / 8);
	const pixels = unfilterRows(
		inflate(Buffer.concat(chunks)),
		rowLength,
		Math.max(1, bitsPerPixel >> 3),
	);
	if (pixels.length < rowLength * height) return undefined;

	const max = (1 << Math.min(depth, 8)) - 1;
	const sample = (row: number, index: number): number => {
		const base = row * rowLength;
		if (depth === 8) return pixels[base + index];
		if (depth === 16) return pixels[base + index * 2];
		const bit = index * depth;
		const value = (pixels[base + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
		// Palette indexes stay indexes; gray levels scale to 0-255.
		return colorType === 3 ? value : Math.round((value * 255) / max);
	};

	const rgba = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const out = (y * width + x) * 4;
			const at = x * channels;
			let r: number;
			let g: number;
			let b: number;
			let a = 255;
			if (colorType === 3) {
				const index = sample(y, x);
				r = palette?.[index * 3] ?? 0;
				g = palette?.[index * 3 + 1] ?? 0;
				b = palette?.[index * 3 + 2] ?? 0;
				a = transparency?.[index] ?? 255;
			} else if (colorType === 0 || colorType === 4) {
				r = g = b = sample(y, at);
				if (colorType === 4) a = sample(y, at + 1);
			} else {
				r = sample(y, at);
				g = sample(y, at + 1);
				b = sample(y, at + 2);
				if (colorType === 6) a = sample(y, at + 3);
			}
			rgba[out] = r;
			rgba[out + 1] = g;
			rgba[out + 2] = b;
			rgba[out + 3] = a;
		}
	}
	return { width, height, data: rgba };
}

/** For each output pixel along one axis, the source pixels it covers and how much of each. */
function coverage(sourceSize: number, targetSize: number): Array<Array<[number, number]>> {
	const scale = sourceSize / targetSize;
	const spans: Array<Array<[number, number]>> = [];
	for (let i = 0; i < targetSize; i++) {
		const start = i * scale;
		const end = start + scale;
		const span: Array<[number, number]> = [];
		for (let s = Math.floor(start); s < Math.min(Math.ceil(end), sourceSize); s++) {
			const weight = Math.min(end, s + 1) - Math.max(start, s);
			if (weight > 0) span.push([s, weight / scale]);
		}
		spans.push(span);
	}
	return spans;
}

/** Shrinks an image by averaging the source pixels under each output pixel, onto white. */
function resize(image: Rgba, width: number, height: number): Rgba {
	const columns = coverage(image.width, width);
	const rows = coverage(image.height, height);

	// Horizontal pass, blending transparent pixels onto white.
	const wide = new Float32Array(width * image.height * 3);
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < width; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			for (const [s, weight] of columns[x]) {
				const at = (y * image.width + s) * 4;
				const alpha = image.data[at + 3] / 255;
				const white = 255 * (1 - alpha);
				r += (image.data[at] * alpha + white) * weight;
				g += (image.data[at + 1] * alpha + white) * weight;
				b += (image.data[at + 2] * alpha + white) * weight;
			}
			const out = (y * width + x) * 3;
			wide[out] = r;
			wide[out + 1] = g;
			wide[out + 2] = b;
		}
	}

	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			for (const [s, weight] of rows[y]) {
				const at = (s * width + x) * 3;
				r += wide[at] * weight;
				g += wide[at + 1] * weight;
				b += wide[at + 2] * weight;
			}
			const out = (y * width + x) * 4;
			data[out] = Math.round(r);
			data[out + 1] = Math.round(g);
			data[out + 2] = Math.round(b);
			data[out + 3] = 255;
		}
	}
	return { width, height, data };
}

/** Turns an image the way its EXIF orientation says, since the re-encoded JPEG has no EXIF. */
function orient(image: Rgba, orientation: number): Rgba {
	if (orientation === 1) return image;
	const swap = orientation >= 5;
	const width = swap ? image.height : image.width;
	const height = swap ? image.width : image.height;
	const data = new Uint32Array(width * height);
	const source = new Uint32Array(
		image.data.buffer,
		image.data.byteOffset,
		image.width * image.height,
	);
	const w = image.width - 1;
	const h = image.height - 1;
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			let tx = y;
			let ty = w - x; // 8: turn 90 degrees counterclockwise
			if (orientation === 2) [tx, ty] = [w - x, y];
			else if (orientation === 3) [tx, ty] = [w - x, h - y];
			else if (orientation === 4) [tx, ty] = [x, h - y];
			else if (orientation === 5) [tx, ty] = [y, x];
			else if (orientation === 6) [tx, ty] = [h - y, x];
			else if (orientation === 7) [tx, ty] = [h - y, w - x];
			data[ty * width + tx] = source[y * image.width + x];
		}
	}
	return { width, height, data: new Uint8Array(data.buffer) };
}

/**
 * Shrinks a JPEG or PNG whose longest side is over `maxSize` pixels, and returns it as a JPEG.
 * Returns undefined when the image is small enough already, or isn't a JPEG or PNG this can read,
 * in which case the original should be sent.
 */
export function downscaleImage(
	data: Buffer,
	maxSize: number,
	quality = 90,
): { data: Buffer; width: number; height: number } | undefined {
	const info = imageInfo(data);
	if (!info || Math.max(info.width, info.height) <= maxSize) return undefined;

	let image: Rgba | undefined;
	try {
		image =
			data[0] === 0xff
				? decodeJpeg(data, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 })
				: decodePng(data);
	} catch {
		// An image this can't decode is sent as it is; the API reads more formats.
		return undefined;
	}
	if (!image) return undefined;

	const scale = maxSize / Math.max(image.width, image.height);
	const width = Math.max(1, Math.round(image.width * scale));
	const height = Math.max(1, Math.round(image.height * scale));
	const resized = orient(resize(image, width, height), info.orientation);
	const jpeg = encodeJpeg(resized, quality);
	return { data: jpeg.data, width: resized.width, height: resized.height };
}
