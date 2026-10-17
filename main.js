const dom = {
    input: document.getElementById("imageInput"),
    browse: document.getElementById("browseButton"),
    dropzone: document.getElementById("dropzone"),
    faces: document.getElementById("faces"),
    loading: document.getElementById("generating"),
    loadingText: document.getElementById("loadingText"),
    fileName: document.getElementById("fileNameDisplay"),
    error: document.getElementById("errorMessage"),
    rotation: document.getElementById("cubeRotation"),
    downloadAll: document.getElementById("downloadAllLink")
};

const faceNames = [
    ["skyboxRt", "Right"],
    ["skyboxLf", "Left"],
    ["skyboxFt", "Front"],
    ["skyboxBk", "Back"],
    ["skyboxUp", "Top"],
    ["skyboxDn", "Bottom"]
];

let currentFile = null;
let fileName = "skybox";
let workers = [];
let objectUrls = [];
let generationId = 0;
let finished = 0;

function showError(message = "") {
    dom.error.textContent = message;
}

function cleanup() {
    generationId++;

    workers.forEach(worker => worker.terminate());
    workers = [];

    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls = [];

    dom.loading.hidden = true;
    dom.downloadAll.disabled = true;
}

function makeImageUrl(imageData) {
    return new Promise((resolve, reject) => {
        const canvas = document.createElement("canvas");
        canvas.width = imageData.width;
        canvas.height = imageData.height;

        const context = canvas.getContext("2d");

        if (!context) {
            reject(new Error("Could not create the image canvas."));
            return;
        }

        context.putImageData(imageData, 0, 0);

        canvas.toBlob(blob => {
            if (!blob) {
                reject(new Error("Could not export the generated image."));
                return;
            }

            const url = URL.createObjectURL(blob);
            objectUrls.push(url);
            resolve(url);
        }, "image/png");
    });
}

function createFace(name, label) {
    const card = document.createElement("article");
    card.className = "face-card";

    const imageWrap = document.createElement("div");
    imageWrap.className = "face-image-wrap";

    const image = document.createElement("img");
    image.alt = `${label} skybox texture`;
    image.loading = "lazy";

    const info = document.createElement("div");
    info.className = "face-info";

    const title = document.createElement("span");
    title.className = "face-name";
    title.textContent = label;

    const download = document.createElement("a");
    download.className = "face-download";
    download.textContent = "↓ PNG";
    download.setAttribute("aria-label", `Download ${label} texture`);

    imageWrap.appendChild(image);
    info.append(title, download);
    card.append(imageWrap, info);
    dom.faces.appendChild(card);

    return { image, download, name };
}

function setLoading(active, message = "Generating your skybox…") {
    dom.loading.hidden = !active;
    dom.loadingText.textContent = message;
}

function processFace(data, faceName, label, rotation, runId) {
    return new Promise((resolve, reject) => {
        const worker = new Worker("./convert.js");
        workers.push(worker);

        const face = createFace(faceName, label);
        let completed = false;

        function stopWithError(error) {
            if (completed) return;
            completed = true;
            worker.terminate();
            reject(error);
        }

        worker.onerror = event => {
            event.preventDefault();
            stopWithError(new Error(event.message || `Failed to generate ${label}.`));
        };

        worker.onmessageerror = () => {
            stopWithError(new Error(`Could not read the ${label} texture.`));
        };

        worker.onmessage = async event => {
            if (runId !== generationId || completed) return;

            const result = event.data;

            if (result.error) {
                stopWithError(new Error(`${label}: ${result.error}`));
                return;
            }

            if (!result.data) {
                stopWithError(new Error(`No image data received for ${label}.`));
                return;
            }

            try {
                const url = await makeImageUrl(result.data);

                if (runId !== generationId) {
                    URL.revokeObjectURL(url);
                    return;
                }

                face.image.src = url;

                if (result.preview) {
                    worker.postMessage({
                        data,
                        face: faceName,
                        rotation,
                        interpolation: "lanczos"
                    });
                    return;
                }

                face.download.href = url;
                face.download.download = `${fileName}_${faceName}.png`;

                completed = true;
                worker.terminate();
                resolve();
            } catch (error) {
                stopWithError(error);
            }
        };

        worker.postMessage({
            data,
            face: faceName,
            rotation,
            maxWidth: 180,
            interpolation: "linear",
            preview: true
        });
    });
}

async function loadFile(file) {
    if (!file) return;

    showError();

    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
        showError("Please upload a PNG, JPG, or WebP image.");
        return;
    }

    if (file.size > 50 * 1024 * 1024) {
        showError("The maximum file size is 50 MB.");
        return;
    }

    cleanup();
    const runId = generationId;

    currentFile = file;
    fileName = file.name.replace(/\.[^.]+$/, "") || "skybox";
    dom.fileName.textContent = file.name;
    dom.faces.replaceChildren();

    const imageUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onerror = () => {
        URL.revokeObjectURL(imageUrl);
        if (runId === generationId) showError("Could not load this image.");
    };

    image.onload = async () => {
        URL.revokeObjectURL(imageUrl);

        if (runId !== generationId) return;

        try {
            const { naturalWidth: width, naturalHeight: height } = image;

            if (width / height < 1.8 || width / height > 2.2) {
                throw new Error("Please use a 2:1 equirectangular panorama.");
            }

            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;

            const context = canvas.getContext("2d", { willReadFrequently: true });
            context.drawImage(image, 0, 0);

            const data = context.getImageData(0, 0, width, height);
            const rotation = Number(dom.rotation.value) * Math.PI / 180;

            setLoading(true);
            finished = 0;

            await Promise.all(faceNames.map(async ([name, label]) => {
                await processFace(data, name, label, rotation, runId);
                finished++;

                if (runId === generationId) {
                    setLoading(true, `Generating textures… ${finished}/6`);
                }
            }));

            if (runId === generationId) {
                setLoading(false);
                dom.downloadAll.disabled = false;
            }
        } catch (error) {
            if (runId === generationId) {
                cleanup();
                showError(error.message || "Skybox generation failed.");
            }
        }
    };

    image.src = imageUrl;
}

dom.browse.addEventListener("click", event => {
    event.stopPropagation();
    dom.input.click();
});

dom.input.addEventListener("change", () => {
    loadFile(dom.input.files[0]);
});

dom.dropzone.addEventListener("click", event => {
    if (event.target.closest("button")) return;
    dom.input.click();
});

["dragenter", "dragover"].forEach(type => {
    dom.dropzone.addEventListener(type, event => {
        event.preventDefault();
        dom.dropzone.classList.add("dragging");
    });
});

["dragleave", "drop"].forEach(type => {
    dom.dropzone.addEventListener(type, event => {
        event.preventDefault();
        dom.dropzone.classList.remove("dragging");
    });
});

dom.dropzone.addEventListener("drop", event => {
    const files = event.dataTransfer.files;

    if (files.length !== 1) {
        showError("Please drop one image at a time.");
        return;
    }

    loadFile(files[0]);
});

dom.rotation.addEventListener("change", () => {
    let value = Number(dom.rotation.value);

    if (!Number.isFinite(value)) value = 0;

    value = Math.max(0, Math.min(359, Math.round(value)));
    dom.rotation.value = value;

    if (currentFile) loadFile(currentFile);
});

dom.downloadAll.addEventListener("click", async () => {
    if (!window.JSZip) {
        showError("ZIP support failed to load. Refresh the page and try again.");
        return;
    }

    const links = [...dom.faces.querySelectorAll(".face-download")];

    if (links.length !== 6 || links.some(link => !link.href || !link.download)) {
        showError("Generate all six textures before downloading the ZIP.");
        return;
    }

    try {
        showError();
        dom.downloadAll.disabled = true;
        dom.downloadAll.textContent = "Preparing ZIP…";

        const zip = new JSZip();

        await Promise.all(links.map(async link => {
            const response = await fetch(link.href);

            if (!response.ok) {
                throw new Error("Could not prepare the ZIP file.");
            }

            zip.file(link.download, await response.blob());
        }));

        const blob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");

        link.href = url;
        link.download = `${fileName}_skybox.zip`;
        link.click();

        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
        showError(error.message || "ZIP download failed.");
    } finally {
        dom.downloadAll.disabled = false;
        dom.downloadAll.textContent = "↓ Download ZIP";
    }
});