/**
 * QR Code generator library (TypeScript)
 * Copyright (c) Project Nayuki. MIT License.
 * https://www.nayuki.io/page/qr-code-generator-library
 *
 * Zero-dependency standalone QR Code generator.
 */

export function generateQrSvg(text: string, size = 200): string {
	const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
	return qr.toSvgString(4, size);
}

export function generateQrDataUrl(text: string): string {
	const svg = generateQrSvg(text, 200);
	return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export class QrCode {
	public static readonly MIN_VERSION: number = 1;
	public static readonly MAX_VERSION: number = 40;

	public static encodeText(text: string, ecl: QrCode.Ecc): QrCode {
		const segs: QrSegment[] = QrSegment.makeSegments(text);
		return QrCode.encodeSegments(segs, ecl);
	}

	public static encodeBinary(data: Readonly<Array<number>> | Uint8Array, ecl: QrCode.Ecc): QrCode {
		const segs: QrSegment[] = [QrSegment.makeBytes(data)];
		return QrCode.encodeSegments(segs, ecl);
	}

	public static encodeSegments(
		segs: Readonly<Array<QrSegment>>,
		ecl: QrCode.Ecc,
		minVersion: number = 1,
		maxVersion: number = 40,
		mask: number = -1,
		boostEcl: boolean = true,
	): QrCode {
		if (
			!(
				QrCode.MIN_VERSION <= minVersion &&
				minVersion <= maxVersion &&
				maxVersion <= QrCode.MAX_VERSION
			) ||
			mask < -1 ||
			mask > 7
		) {
			throw new RangeError("Invalid value");
		}

		let version: number;
		let dataUsedBits: number;
		for (version = minVersion; ; version++) {
			const dataCapacityBits: number = QrCode.getNumDataCodewords(version, ecl) * 8;
			const usedBits: number = QrSegment.getTotalBits(segs, version);
			if (usedBits <= dataCapacityBits) {
				dataUsedBits = usedBits;
				break;
			}
			if (version >= maxVersion) {
				throw new RangeError("Data too long");
			}
		}

		if (boostEcl) {
			for (const newEcl of [QrCode.Ecc.QUARTILE, QrCode.Ecc.HIGH]) {
				if (dataUsedBits <= QrCode.getNumDataCodewords(version, newEcl) * 8) ecl = newEcl;
			}
		}

		const bb: number[] = [];
		for (const seg of segs) {
			appendBits(seg.mode.modeBits, 4, bb);
			appendBits(seg.numChars, seg.mode.numCharCountBits(version), bb);
			for (const b of seg.getData()) bb.push(b);
		}
		if (bb.length !== dataUsedBits) throw new Error("Assertion error");

		const dataCapacityBits: number = QrCode.getNumDataCodewords(version, ecl) * 8;
		if (bb.length > dataCapacityBits) throw new Error("Assertion error");
		appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
		appendBits(0, (8 - (bb.length % 8)) % 8, bb);
		if (bb.length % 8 !== 0) throw new Error("Assertion error");

		for (let padByte = 0xec; bb.length < dataCapacityBits; padByte ^= 0xec ^ 0x11) {
			appendBits(padByte, 8, bb);
		}

		const dataCodewords: number[] = new Array<number>(bb.length / 8).fill(0);
		for (let i = 0; i < bb.length; i++) dataCodewords[i >>> 3] |= bb[i] << (7 - (i & 7));

		return new QrCode(version, ecl, dataCodewords, mask);
	}

	public readonly size: number;
	public readonly mask: number;
	private readonly modules: boolean[][] = [];
	private readonly isFunction: boolean[][] = [];

	public constructor(
		public readonly version: number,
		public readonly errorCorrectionLevel: QrCode.Ecc,
		dataCodewords: Readonly<Array<number>>,
		msk: number,
	) {
		if (version < QrCode.MIN_VERSION || version > QrCode.MAX_VERSION)
			throw new RangeError("Version value out of range");
		if (msk < -1 || msk > 7) throw new RangeError("Mask value out of range");
		this.size = version * 4 + 17;

		const row: boolean[] = new Array<boolean>(this.size).fill(false);
		for (let i = 0; i < this.size; i++) {
			this.modules.push(row.slice());
			this.isFunction.push(row.slice());
		}

		this.drawFunctionPatterns();
		const allCodewords: number[] = this.addEccAndInterleave(dataCodewords);
		this.drawCodewords(allCodewords);

		if (msk === -1) {
			let minPenalty: number = 1000000000;
			for (let i = 0; i < 8; i++) {
				this.applyMask(i);
				this.drawFormatBits(i);
				const penalty: number = this.getPenaltyScore();
				if (penalty < minPenalty) {
					minPenalty = penalty;
					msk = i;
				}
				this.applyMask(i);
			}
		}

		this.mask = msk;
		this.applyMask(msk);
		this.drawFormatBits(msk);

		this.isFunction = [];
	}

	public getModule(x: number, y: number): boolean {
		return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x];
	}

	public toSvgString(border: number, size = 200): string {
		if (border < 0) throw new RangeError("Border must be non-negative");
		const totalSize = this.size + border * 2;
		let parts: string[] = [];
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				if (this.getModule(x, y)) {
					parts.push(`<rect x="${x + border}" y="${y + border}" width="1" height="1"/>`);
				}
			}
		}
		return (
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${size}" height="${size}" shape-rendering="crispEdges">` +
			`<rect width="${totalSize}" height="${totalSize}" fill="#ffffff"/>` +
			`<g fill="#000000">${parts.join("")}</g></svg>`
		);
	}

	private drawFunctionPatterns(): void {
		for (let i = 0; i < this.size; i++) {
			this.setFunctionModule(6, i, i % 2 === 0);
			this.setFunctionModule(i, 6, i % 2 === 0);
		}

		this.drawFinderPattern(3, 3);
		this.drawFinderPattern(this.size - 4, 3);
		this.drawFinderPattern(3, this.size - 4);

		const alignPatPos: number[] = this.getAlignmentPatternPositions();
		const numAlign: number = alignPatPos.length;
		for (let i = 0; i < numAlign; i++) {
			for (let j = 0; j < numAlign; j++) {
				if (
					(i === 0 && j === 0) ||
					(i === 0 && j === numAlign - 1) ||
					(i === numAlign - 1 && j === 0)
				)
					continue;
				else this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
			}
		}

		this.drawFormatBits(0);
		this.drawVersion();
	}

	private drawFormatBits(mask: number): void {
		const data: number = (this.errorCorrectionLevel.formatBits << 3) | mask;
		let rem: number = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits: number = ((data << 10) | rem) ^ 0x5412;

		for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
		this.setFunctionModule(8, 7, getBit(bits, 6));
		this.setFunctionModule(8, 8, getBit(bits, 7));
		this.setFunctionModule(7, 8, getBit(bits, 8));
		for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));

		for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
		for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
		this.setFunctionModule(8, this.size - 8, true);
	}

	private drawVersion(): void {
		if (this.version < 7) return;
		let rem: number = this.version;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const bits: number = (this.version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const bit: boolean = getBit(bits, i);
			const a: number = this.size - 11 + (i % 3);
			const b: number = Math.floor(i / 3);
			this.setFunctionModule(a, b, bit);
			this.setFunctionModule(b, a, bit);
		}
	}

	private drawFinderPattern(x: number, y: number): void {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const dist: number = Math.max(Math.abs(dx), Math.abs(dy));
				const xx: number = x + dx;
				const yy: number = y + dy;
				if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size) {
					this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
				}
			}
		}
	}

	private drawAlignmentPattern(x: number, y: number): void {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
			}
		}
	}

	private setFunctionModule(x: number, y: number, isDark: boolean): void {
		this.modules[y][x] = isDark;
		this.isFunction[y][x] = true;
	}

	private addEccAndInterleave(data: Readonly<Array<number>>): number[] {
		const ver: number = this.version;
		const ecl: QrCode.Ecc = this.errorCorrectionLevel;
		if (data.length !== QrCode.getNumDataCodewords(ver, ecl))
			throw new IllegalArgumentError("Invalid argument");

		const numBlocks: number = QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
		const blockEccLen: number = QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
		const rawCodewords: number = Math.floor(QrCode.getNumRawDataModules(ver) / 8);
		const numShortBlocks: number = numBlocks - (rawCodewords % numBlocks);
		const shortBlockLen: number = Math.floor(rawCodewords / numBlocks);

		const blocks: number[][] = [];
		const rsDiv: number[] = QrCode.reedSolomonComputeDivisor(blockEccLen);
		for (let i = 0, k = 0; i < numBlocks; i++) {
			const dat: number[] = data.slice(
				k,
				k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1),
			);
			k += dat.length;
			const ecc: number[] = QrCode.reedSolomonComputeRemainder(dat, rsDiv);
			if (i < numShortBlocks) dat.splice(shortBlockLen - blockEccLen, 0, 0);
			blocks.push(dat.concat(ecc));
		}

		const result: number[] = [];
		for (let i = 0; i < blocks[0].length; i++) {
			for (let j = 0; j < blocks.length; j++) {
				if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
					result.push(blocks[j][i]);
				}
			}
		}
		return result;
	}

	private drawCodewords(data: Readonly<Array<number>>): void {
		if (data.length !== Math.floor(QrCode.getNumRawDataModules(this.version) / 8)) {
			throw new IllegalArgumentError("Invalid argument");
		}
		let i = 0;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < this.size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x: number = right - j;
					const upward: boolean = ((right + 1) & 2) === 0;
					const y: number = upward ? this.size - 1 - vert : vert;
					if (!this.isFunction[y][x] && i < data.length * 8) {
						this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
						i++;
					}
				}
			}
		}
		if (i !== data.length * 8) throw new Error("Assertion error");
	}

	private applyMask(mask: number): void {
		if (mask < 0 || mask > 7) throw new RangeError("Mask value out of range");
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				let invert: boolean;
				switch (mask) {
					case 0:
						invert = (x + y) % 2 === 0;
						break;
					case 1:
						invert = y % 2 === 0;
						break;
					case 2:
						invert = x % 3 === 0;
						break;
					case 3:
						invert = (x + y) % 3 === 0;
						break;
					case 4:
						invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
						break;
					case 5:
						invert = ((x * y) % 2) + ((x * y) % 3) === 0;
						break;
					case 6:
						invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
						break;
					case 7:
						invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
						break;
					default:
						throw new Error("Unreachable");
				}
				if (!this.isFunction[y][x] && invert) {
					this.modules[y][x] = !this.modules[y][x];
				}
			}
		}
	}

	private getPenaltyScore(): number {
		let result: number = 0;
		for (let y = 0; y < this.size; y++) {
			let runColor = false;
			let runX = 0;
			const runHistory = [0, 0, 0, 0, 0, 0, 0];
			for (let x = 0; x < this.size; x++) {
				if (this.modules[y][x] === runColor) {
					runX++;
					if (runX === 5) result += 3;
					else if (runX > 5) result++;
				} else {
					this.finderPenaltyAddHistory(runX, runHistory);
					if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * 40;
					runColor = this.modules[y][x];
					runX = 1;
				}
			}
			result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * 40;
		}

		for (let x = 0; x < this.size; x++) {
			let runColor = false;
			let runY = 0;
			const runHistory = [0, 0, 0, 0, 0, 0, 0];
			for (let y = 0; y < this.size; y++) {
				if (this.modules[y][x] === runColor) {
					runY++;
					if (runY === 5) result += 3;
					else if (runY > 5) result++;
				} else {
					this.finderPenaltyAddHistory(runY, runHistory);
					if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * 40;
					runColor = this.modules[y][x];
					runY = 1;
				}
			}
			result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * 40;
		}

		for (let y = 0; y < this.size - 1; y++) {
			for (let x = 0; x < this.size - 1; x++) {
				const color: boolean = this.modules[y][x];
				if (
					color === this.modules[y][x + 1] &&
					color === this.modules[y + 1][x] &&
					color === this.modules[y + 1][x + 1]
				) {
					result += 3;
				}
			}
		}

		let dark: number = 0;
		for (const row of this.modules) {
			for (const color of row) {
				if (color) dark++;
			}
		}
		const total: number = this.size * this.size;
		const k: number = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
		result += k * 10;
		return result;
	}

	private getAlignmentPatternPositions(): number[] {
		if (this.version === 1) return [];
		else {
			const num: number = Math.floor(this.version / 7) + 2;
			const step: number =
				this.version === 32
					? 26
					: Math.ceil((this.version * 4 + 4) / (num * 2 - 2)) * 2;
			const result: number[] = [6];
			for (let pos = this.size - 7; result.length < num; pos -= step) {
				result.splice(1, 0, pos);
			}
			return result;
		}
	}

	private static getNumRawDataModules(ver: number): number {
		if (ver < QrCode.MIN_VERSION || ver > QrCode.MAX_VERSION)
			throw new RangeError("Version number out of range");
		return QrCode.NUM_RAW_DATA_MODULES[ver];
	}

	private static readonly NUM_RAW_DATA_MODULES: readonly [-1, 208, 359, 567, 807, 1079, 1383, 1568, 1936, 2336, 2768, 3232, 3728, 4256, 4651, 5243, 5867, 6523, 7211, 7931, 8683, 9252, 10068, 10916, 11796, 12708, 13652, 14628, 15371, 16411, 17483, 18587, 19723, 20891, 22091, 23008, 24272, 25568, 26896, 28256, 29648] = [
		-1, 208, 359, 567, 807, 1079, 1383, 1568, 1936, 2336, 2768, 3232, 3728, 4256, 4651, 5243, 5867, 6523, 7211, 7931, 8683, 9252, 10068, 10916, 11796, 12708, 13652, 14628, 15371, 16411, 17483, 18587, 19723, 20891, 22091, 23008, 24272, 25568, 26896, 28256, 29648,
	];
	private static getNumDataCodewords(ver: number, ecl: QrCode.Ecc): number {
		return (
			Math.floor(QrCode.getNumRawDataModules(ver) / 8) -
			QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] *
				QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver]
		);
	}

	private static reedSolomonComputeDivisor(degree: number): number[] {
		if (degree < 1 || degree > 255) throw new RangeError("Degree out of range");
		const result: number[] = new Array<number>(degree).fill(0);
		result[degree - 1] = 1;
		let root = 1;
		for (let i = 0; i < degree; i++) {
			for (let j = 0; j < result.length; j++) {
				result[j] = QrCode.reedSolomonMultiply(result[j], root);
				if (j + 1 < result.length) result[j] ^= result[j + 1];
			}
			root = QrCode.reedSolomonMultiply(root, 0x02);
		}
		return result;
	}

	private static reedSolomonComputeRemainder(
		data: Readonly<Array<number>>,
		divisor: Readonly<Array<number>>,
	): number[] {
		const result: number[] = divisor.map(() => 0);
		for (const b of data) {
			const factor: number = b ^ result.shift()!;
			result.push(0);
			divisor.forEach(
				(coef, i) => (result[i] ^= QrCode.reedSolomonMultiply(coef, factor)),
			);
		}
		return result;
	}

	private static reedSolomonMultiply(x: number, y: number): number {
		if (x >>> 8 !== 0 || y >>> 8 !== 0) throw new RangeError("Byte out of range");
		let z: number = 0;
		for (let i = 7; i >= 0; i--) {
			z = (z << 1) ^ ((z >>> 7) * 0x11d);
			z ^= ((y >>> i) & 1) * x;
		}

		return z;
	}

	private finderPenaltyCountPatterns(runHistory: Readonly<Array<number>>): number {
		const n = runHistory[1];

		const core =
			n > 0 &&
			runHistory[2] === n &&
			runHistory[3] === n * 3 &&
			runHistory[4] === n &&
			runHistory[5] === n;

		return (
			(core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
			(core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
		);
	}

	private finderPenaltyTerminateAndCount(
		currentRunColor: boolean,
		currentRunLength: number,
		runHistory: number[],
	): number {
		if (currentRunColor) {
			this.finderPenaltyAddHistory(currentRunLength, runHistory);
			currentRunLength = 0;
		}
		currentRunLength += this.size;
		this.finderPenaltyAddHistory(currentRunLength, runHistory);
		return this.finderPenaltyCountPatterns(runHistory);
	}

	private finderPenaltyAddHistory(currentRunLength: number, runHistory: number[]): void {
		if (runHistory[0] === 0) currentRunLength += this.size;
		runHistory.pop();
		runHistory.unshift(currentRunLength);
	}

	private static readonly ECC_CODEWORDS_PER_BLOCK: number[][] = [
		// Version: 0, 1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40
		[
			-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28,
			28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
		], // Low
		[
			-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
			26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
		], // Medium
		[
			-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30,
			28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
		], // Quartile
		[
			-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28,
			30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
		], // High
	];

	private static readonly NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
		// Version: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40
		[
			-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12,
			12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
		], // Low
		[
			-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20,
			21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
		], // Medium
		[
			-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25,
			27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
		], // Quartile
		[
			-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34,
			30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
		], // High
	];
}

export namespace QrCode {
	export class Ecc {
		public static readonly LOW = new Ecc(0, 1);
		public static readonly MEDIUM = new Ecc(1, 0);
		public static readonly QUARTILE = new Ecc(2, 3);
		public static readonly HIGH = new Ecc(3, 2);

		private constructor(
			public readonly ordinal: number,
			public readonly formatBits: number,
		) {}
	}
}

export class QrSegment {
	public static makeBytes(data: Readonly<Array<number>> | Uint8Array): QrSegment {
		const bb: number[] = [];
		for (const b of data) appendBits(b, 8, bb);
		return new QrSegment(QrSegment.Mode.BYTE, data.length, bb);
	}

	public static makeNumeric(digits: string): QrSegment {
		if (!QrSegment.isNumeric(digits))
			throw new IllegalArgumentError("String contains non-numeric characters");
		const bb: number[] = [];
		for (let i = 0; i < digits.length; ) {
			const n: number = Math.min(digits.length - i, 3);
			appendBits(parseInt(digits.substring(i, i + n), 10), n * 3 + 1, bb);
			i += n;
		}
		return new QrSegment(QrSegment.Mode.NUMERIC, digits.length, bb);
	}

	public static makeAlphanumeric(text: string): QrSegment {
		if (!QrSegment.isAlphanumeric(text)) {
			throw new IllegalArgumentError(
				"String contains unencodable characters in alphanumeric mode",
			);
		}
		const bb: number[] = [];
		let i: number;
		for (i = 0; i + 2 <= text.length; i += 2) {
			const temp: number =
				QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)) * 45 +
				QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i + 1));
			appendBits(temp, 11, bb);
		}
		if (i < text.length) {
			appendBits(QrSegment.ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)), 6, bb);
		}
		return new QrSegment(QrSegment.Mode.ALPHANUMERIC, text.length, bb);
	}

	public static makeSegments(text: string): QrSegment[] {
		if (text === "") return [];
		else if (QrSegment.isNumeric(text)) return [QrSegment.makeNumeric(text)];
		else if (QrSegment.isAlphanumeric(text)) return [QrSegment.makeAlphanumeric(text)];
		else return [QrSegment.makeBytes(new TextEncoder().encode(text))];
	}

	public static getTotalBits(segs: Readonly<Array<QrSegment>>, version: number): number {
		let result: number = 0;
		for (const seg of segs) {
			const cc: number = seg.mode.numCharCountBits(version);
			if (seg.numChars >= 1 << cc) return Infinity;
			result += 4 + cc + seg.getData().length;
		}
		return result;
	}

	public constructor(
		public readonly mode: QrSegment.Mode,
		public readonly numChars: number,
		private readonly bitData: number[],
	) {
		if (numChars < 0) throw new RangeError("Invalid argument");
		this.bitData = bitData.slice();
	}

	public getData(): number[] {
		return this.bitData.slice();
	}

	public static isNumeric(text: string): boolean {
		return QrSegment.NUMERIC_REGEX.test(text);
	}

	public static isAlphanumeric(text: string): boolean {
		return QrSegment.ALPHANUMERIC_REGEX.test(text);
	}

	private static readonly NUMERIC_REGEX: RegExp = /^[0-9]*$/;
	private static readonly ALPHANUMERIC_REGEX: RegExp = /^[0-9A-Z $%*+.\/:-]*$/;
	private static readonly ALPHANUMERIC_CHARSET: string =
		"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
}

export namespace QrSegment {
	export class Mode {
		public static readonly NUMERIC = new Mode(0x1, [10, 12, 14]);
		public static readonly ALPHANUMERIC = new Mode(0x2, [9, 11, 13]);
		public static readonly BYTE = new Mode(0x4, [8, 16, 16]);
		public static readonly KANJI = new Mode(0x8, [8, 10, 12]);
		public static readonly ECI = new Mode(0x7, [0, 0, 0]);

		private constructor(
			public readonly modeBits: number,
			private readonly numBitsCharCount: [number, number, number],
		) {}

		public numCharCountBits(ver: number): number {
			return this.numBitsCharCount[Math.floor((ver + 7) / 17)];
		}
	}
}

function appendBits(val: number, len: number, bb: number[]): void {
	if (len < 0 || len > 31 || val >>> len !== 0) throw new RangeError("Value out of range");
	for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

function getBit(val: number, i: number): boolean {
	return ((val >>> i) & 1) !== 0;
}

class IllegalArgumentError extends Error {}
