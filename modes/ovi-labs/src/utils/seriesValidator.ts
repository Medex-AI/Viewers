const REFERENCE_SOP_INSTANCE_UID =
  '1.3.12.2.1107.5.2.43.166183.2020121421485830282635282';

const KEYWORD_REGEX = /(cine|dynamic|peristalsis|uterus)/i;

const toNumberArray = value => {
  if (!Array.isArray(value)) {
    return null;
  }

  const numbers = value.map(Number).filter(item => Number.isFinite(item));
  return numbers.length === 6 ? numbers : null;
};

const getFirstInstance = displaySet =>
  displaySet?.instances?.[0] || displaySet?.images?.[0] || displaySet?.instance;

export const checkSagittalOrientation = imageOrientationPatient => {
  const iop = toNumberArray(imageOrientationPatient);
  if (!iop) {
    return false;
  }

  const row = iop.slice(0, 3);
  const col = iop.slice(3, 6);
  const normal = [
    row[1] * col[2] - row[2] * col[1],
    row[2] * col[0] - row[0] * col[2],
    row[0] * col[1] - row[1] * col[0],
  ];

  return normal[0] > 0.8;
};

export const isSuitableForOviLabs = displaySet => {
  if (!displaySet) {
    return false;
  }

  const instance = getFirstInstance(displaySet);
  const modality = displaySet.Modality || displaySet.modality || instance?.Modality;
  const seriesDescription =
    displaySet.SeriesDescription ||
    displaySet.seriesDescription ||
    instance?.SeriesDescription ||
    '';
  const numberOfFrames = Number(
    displaySet.NumberOfFrames ||
      instance?.NumberOfFrames ||
      displaySet.numImageFrames ||
      displaySet.images?.length ||
      displaySet.instances?.length ||
      0
  );
  const imageOrientationPatient =
    displaySet.ImageOrientationPatient || instance?.ImageOrientationPatient;
  const sopInstanceUID = displaySet.SOPInstanceUID || instance?.SOPInstanceUID;

  const isReference = sopInstanceUID === REFERENCE_SOP_INSTANCE_UID;
  const isMr = modality === 'MR';
  const isSagittal = checkSagittalOrientation(imageOrientationPatient);
  const hasKeyword = KEYWORD_REGEX.test(seriesDescription);
  const hasEnoughFrames = numberOfFrames > 20;

  return isReference || (isMr && isSagittal && hasKeyword && hasEnoughFrames);
};
