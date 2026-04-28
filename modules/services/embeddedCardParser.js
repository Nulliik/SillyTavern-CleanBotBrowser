function readUint32BE(view, offset) {
    return view.getUint32(offset, false);
}

function decodeBytes(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
}

function decodeTextChunk(bytes) {
    const separator = bytes.indexOf(0);
    if (separator === -1) return null;

    return {
        keyword: decodeBytes(bytes.slice(0, separator)),
        text: decodeBytes(bytes.slice(separator + 1)),
    };
}

function decodeITXtChunk(bytes) {
    let offset = 0;

    const readZeroTerminated = () => {
        const separator = bytes.indexOf(0, offset);
        if (separator === -1) return null;
        const value = decodeBytes(bytes.slice(offset, separator));
        offset = separator + 1;
        return value;
    };

    const keyword = readZeroTerminated();
    if (!keyword || offset + 2 > bytes.length) return null;

    const compressionFlag = bytes[offset];
    offset += 1;
    offset += 1; // compression method

    if (readZeroTerminated() == null) return null; // language tag
    if (readZeroTerminated() == null) return null; // translated keyword

    if (compressionFlag === 1) {
        // Compressed iTXt is not expected on the providers we use here.
        return null;
    }

    return {
        keyword,
        text: decodeBytes(bytes.slice(offset)),
    };
}

function decodeMaybeBase64(text) {
    const candidate = String(text || '').trim();
    if (!candidate) return '';

    try {
        return atob(candidate);
    } catch {
        return candidate;
    }
}

function parseEmbeddedPayload(text) {
    const decoded = decodeMaybeBase64(text);

    try {
        return JSON.parse(decoded);
    } catch {
        try {
            return JSON.parse(String(text || ''));
        } catch {
            return null;
        }
    }
}

export function extractCharacterDataFromPngArrayBuffer(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer)) {
        throw new Error('PNG parser expected an ArrayBuffer.');
    }

    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 8) {
        throw new Error('PNG file is too small.');
    }

    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < signature.length; i++) {
        if (bytes[i] !== signature[i]) {
            throw new Error('File is not a PNG image.');
        }
    }

    const view = new DataView(arrayBuffer);
    let offset = 8;
    let charaPayload = null;
    let ccv3Payload = null;

    while (offset + 8 <= bytes.length) {
        const length = readUint32BE(view, offset);
        const type = decodeBytes(bytes.slice(offset + 4, offset + 8));
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;

        if (dataEnd + 4 > bytes.length) break;

        const chunkData = bytes.slice(dataStart, dataEnd);
        let decoded = null;

        if (type === 'tEXt') {
            decoded = decodeTextChunk(chunkData);
        } else if (type === 'iTXt') {
            decoded = decodeITXtChunk(chunkData);
        }

        if (decoded?.keyword) {
            const keyword = decoded.keyword.toLowerCase();
            if (keyword === 'ccv3') ccv3Payload = decoded.text;
            if (keyword === 'chara') charaPayload = decoded.text;
        }

        offset = dataEnd + 4;
        if (type === 'IEND') break;
    }

    const payload = ccv3Payload || charaPayload;
    if (!payload) {
        throw new Error('PNG metadata does not contain character data.');
    }

    const parsed = parseEmbeddedPayload(payload);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Embedded character payload is invalid.');
    }

    return parsed;
}
