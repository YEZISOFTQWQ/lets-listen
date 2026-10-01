(function coverValidation(root) {
  'use strict';

  root.validateCoverImage = async (dataUrl) => {
    const image = new Image();
    let timer;
    try {
      image.src = dataUrl;
      await Promise.race([
        image.decode(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('封面解码超时')), 15000);
        }),
      ]);
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尺寸无效');
    } catch {
      image.src = '';
      throw new Error('封面图片无法解码或解码超时，请选择较小且未损坏的图片');
    } finally {
      clearTimeout(timer);
    }
  };
}(globalThis));
