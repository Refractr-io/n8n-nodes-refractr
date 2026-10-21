import { Inflate } from 'pako';

/** Decompresses zlib data, as used in PDF streams and PNG images. */
export function inflate(data: Uint8Array): Uint8Array {
	const inflator = new Inflate();
	inflator.push(data, true);
	if (inflator.err || !(inflator.result instanceof Uint8Array)) {
		throw new Error(`Compressed data is damaged (${inflator.msg || 'no data'})`);
	}
	return inflator.result;
}

/**
 * Undoes PNG row filters, which PNG images and PDF streams with a /Predictor of 10 or more use.
 * Each row starts with a filter type byte.
 */
export function unfilterRows(
	data: Uint8Array,
	rowLength: number,
	bytesPerPixel: number,
): Uint8Array {
	const rows = Math.floor(data.length / (rowLength + 1));
	const output = new Uint8Array(rows * rowLength);
	for (let row = 0; row < rows; row++) {
		const filter = data[row * (rowLength + 1)];
		const input = row * (rowLength + 1) + 1;
		const out = row * rowLength;
		for (let i = 0; i < rowLength; i++) {
			const left = i >= bytesPerPixel ? output[out + i - bytesPerPixel] : 0;
			const up = row > 0 ? output[out + i - rowLength] : 0;
			const upLeft =
				row > 0 && i >= bytesPerPixel ? output[out + i - rowLength - bytesPerPixel] : 0;
			let predicted = 0;
			if (filter === 1) predicted = left;
			else if (filter === 2) predicted = up;
			else if (filter === 3) predicted = (left + up) >> 1;
			else if (filter === 4) {
				const estimate = left + up - upLeft;
				const toLeft = Math.abs(estimate - left);
				const toUp = Math.abs(estimate - up);
				const toUpLeft = Math.abs(estimate - upLeft);
				predicted = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
			}
			output[out + i] = (data[input + i] + predicted) & 0xff;
		}
	}
	return output;
}
