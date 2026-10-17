function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function mod(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
}

function copyPixelNearest(read, write) {
    const { width, height, data } = read;

    return (x, y, to) => {
        const px = clamp(Math.round(x), 0, width - 1);
        const py = clamp(Math.round(y), 0, height - 1);
        const from = 4 * (py * width + px);

        write.data[to] = data[from];
        write.data[to + 1] = data[from + 1];
        write.data[to + 2] = data[from + 2];
    };
}

function copyPixelBilinear(read, write) {
    const { width, height, data } = read;

    return (x, y, to) => {
        const x0 = clamp(Math.floor(x), 0, width - 1);
        const y0 = clamp(Math.floor(y), 0, height - 1);
        const x1 = Math.min(x0 + 1, width - 1);
        const y1 = Math.min(y0 + 1, height - 1);

        const fx = clamp(x - Math.floor(x), 0, 1);
        const fy = clamp(y - Math.floor(y), 0, 1);

        const p00 = 4 * (y0 * width + x0);
        const p10 = 4 * (y0 * width + x1);
        const p01 = 4 * (y1 * width + x0);
        const p11 = 4 * (y1 * width + x1);

        for (let c = 0; c < 3; c++) {
            const top = data[p00 + c] * (1 - fx) + data[p10 + c] * fx;
            const bottom = data[p01 + c] * (1 - fx) + data[p11 + c] * fx;

            write.data[to + c] = Math.round(top * (1 - fy) + bottom * fy);
        }
    };
}

function kernelResample(read, write, radius, kernel) {
    const { width, height, data } = read;
    const size = radius * 2;
    const xWeights = new Float64Array(size);
    const yWeights = new Float64Array(size);

    return (x, y, to) => {
        const startX = Math.floor(x) - radius + 1;
        const startY = Math.floor(y) - radius + 1;

        let totalX = 0;
        let totalY = 0;

        for (let i = 0; i < size; i++) {
            xWeights[i] = kernel(x - (startX + i));
            yWeights[i] = kernel(y - (startY + i));
            totalX += xWeights[i];
            totalY += yWeights[i];
        }

        if (totalX !== 0) {
            for (let i = 0; i < size; i++) xWeights[i] /= totalX;
        }

        if (totalY !== 0) {
            for (let i = 0; i < size; i++) yWeights[i] /= totalY;
        }

        for (let c = 0; c < 3; c++) {
            let result = 0;

            for (let i = 0; i < size; i++) {
                const py = clamp(startY + i, 0, height - 1);
                let row = 0;

                for (let j = 0; j < size; j++) {
                    const px = clamp(startX + j, 0, width - 1);
                    row += data[4 * (py * width + px) + c] * xWeights[j];
                }

                result += row * yWeights[i];
            }

            write.data[to + c] = clamp(Math.round(result), 0, 255);
        }
    };
}

function copyPixelBicubic(read, write) {
    const b = -0.5;

    const kernel = value => {
        const x = Math.abs(value);
        const x2 = x * x;
        const x3 = x2 * x;

        return x <= 1
            ? (b + 2) * x3 - (b + 3) * x2 + 1
            : b * x3 - 5 * b * x2 + 8 * b * x - 4 * b;
    };

    return kernelResample(read, write, 2, kernel);
}

function copyPixelLanczos(read, write) {
    const radius = 5;

    const kernel = value => {
        if (value === 0) return 1;

        const x = Math.PI * value;

        if (Math.abs(value) >= radius) return 0;

        return radius * Math.sin(x) * Math.sin(x / radius) / (x * x);
    };

    return kernelResample(read, write, radius, kernel);
}

const orientations = {
    skyboxRt: (out, x, y) => {
        out.x = -1;
        out.y = -x;
        out.z = -y;
    },

    skyboxLf: (out, x, y) => {
        out.x = 1;
        out.y = x;
        out.z = -y;
    },

    skyboxFt: (out, x, y) => {
        out.x = x;
        out.y = -1;
        out.z = -y;
    },

    skyboxBk: (out, x, y) => {
        out.x = -x;
        out.y = 1;
        out.z = -y;
    },

    skyboxUp: (out, x, y) => {
        out.x = -y;
        out.y = -x;
        out.z = 1;
    },

    skyboxDn: (out, x, y) => {
        out.x = y;
        out.y = -x;
        out.z = -1;
    }
};

function renderFace({
    data: readData,
    face,
    rotation = 0,
    interpolation = "lanczos",
    maxWidth = Infinity,
    preview = false
}) {
    const orientation = orientations[face];

    if (!orientation) {
        throw new Error(`Unknown skybox face: ${face}`);
    }

    const faceWidth = Math.max(
        1,
        Math.floor(Math.min(maxWidth, readData.width / 4))
    );

    const faceHeight = faceWidth;
    const output = new ImageData(faceWidth, faceHeight);
    const cube = {};

    const copyPixel = {
        linear: copyPixelBilinear,
        cubic: copyPixelBicubic,
        lanczos: copyPixelLanczos
    }[interpolation]?.(readData, output) ?? copyPixelNearest(readData, output);

    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);

    for (let y = 0; y < faceHeight; y++) {
        for (let x = 0; x < faceWidth; x++) {
            const to = 4 * (y * faceWidth + x);

            orientation(
                cube,
                2 * (x + 0.5) / faceWidth - 1,
                2 * (y + 0.5) / faceHeight - 1
            );

            const rotatedX = cube.x * cosine - cube.y * sine;
            const rotatedY = cube.x * sine + cube.y * cosine;

            const length = Math.hypot(rotatedX, rotatedY, cube.z);
            const longitude = mod(
                Math.atan2(rotatedY, rotatedX),
                2 * Math.PI
            );

            const latitude = Math.acos(clamp(cube.z / length, -1, 1));

            const sourceX = readData.width * longitude / (2 * Math.PI) - 0.5;
            const sourceY = readData.height * latitude / Math.PI - 0.5;

            copyPixel(sourceX, sourceY, to);
            output.data[to + 3] = 255;
        }
    }

    postMessage({
        data: output,
        preview
    });
}

onmessage = function (event) {
    try {
        renderFace(event.data);
    } catch (error) {
        postMessage({
            error: error.message,
            preview: event.data?.preview ?? false
        });
    }
};