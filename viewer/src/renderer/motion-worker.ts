import cvModule from "@techstark/opencv-js";

let cv: any;
let previous: Uint8Array | null = null;
async function initialize() {
  const module: any = cvModule;
  cv = module instanceof Promise ? await module : module;
  if (!cv.Mat)
    await new Promise<void>((resolve) => {
      cv.onRuntimeInitialized = resolve;
    });
  self.postMessage({ ready: true });
}
void initialize().catch((failure) =>
  self.postMessage({ error: String(failure) }),
);
self.onmessage = ({ data }) => {
  if (data.reset) {
    previous = null;
    return;
  }
  if (!cv?.Mat) return;
  const { image, settings } = data;
  const { width, height } = image;
  const mats: any[] = [];
  try {
    const source = cv.matFromImageData(image);
    mats.push(source);
    const gray = new cv.Mat();
    mats.push(gray);
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const boxes = [];
    if (previous && previous.length === gray.data.length) {
      const before = cv.matFromArray(height, width, cv.CV_8UC1, previous);
      mats.push(before);
      const difference = new cv.Mat();
      mats.push(difference);
      cv.absdiff(gray, before, difference);
      cv.threshold(
        difference,
        difference,
        8 + (100 - settings.sensitivity) * 0.5,
        255,
        cv.THRESH_BINARY,
      );
      for (let row = Math.round(height * 0.88); row < height; row++)
        difference.data.fill(0, row * width, (row + 1) * width);
      const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      mats.push(kernel);
      cv.dilate(difference, difference, kernel);
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      mats.push(contours, hierarchy);
      cv.findContours(
        difference,
        contours,
        hierarchy,
        cv.RETR_EXTERNAL,
        cv.CHAIN_APPROX_SIMPLE,
      );
      for (let index = 0; index < contours.size(); index++) {
        const contour = contours.get(index);
        try {
          const area = cv.contourArea(contour);
          if (
            area < 40 + (100 - settings.sensitivity) * 2 ||
            area > width * height * 0.7
          )
            continue;
          const rect = cv.boundingRect(contour);
          const left = Math.max(0, rect.x - settings.padding);
          const top = Math.max(0, rect.y - settings.padding);
          boxes.push({
            x: (left / width) * 100,
            y: (top / height) * 100,
            width:
              ((Math.min(width, rect.x + rect.width + settings.padding) -
                left) /
                width) *
              100,
            height:
              ((Math.min(height, rect.y + rect.height + settings.padding) -
                top) /
                height) *
              100,
          });
        } finally {
          contour.delete();
        }
      }
    }
    previous = new Uint8Array(gray.data);
    self.postMessage({ boxes: boxes.slice(0, 32) });
  } catch (failure) {
    self.postMessage({ error: String(failure) });
  } finally {
    for (const mat of mats) mat.delete();
  }
};
