(function coverValidation(root) {
  'use strict';

  root.validateCoverImage = async (dataUrl) => {
    const image = new Image();
    image.src = dataUrl;
    try {
      await image.decode();
    } catch {
      throw new Error('封面图片无法解码，请选择未损坏的图片');
    }
    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error('封面图片无法解码，请选择未损坏的图片');
    }
  };
}(globalThis));
