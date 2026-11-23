import { api } from './api';

/**
 * Upload a picture for use in an email and get back its public address.
 * It is shrunk in the browser first, so a phone photo does not make the email heavy. PNG stays PNG
 * (logos keep their transparent background); photos become JPEG, which every mail program shows.
 */
export async function uploadImage(file: File, maxSide: number): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Use a PNG, JPEG, WebP or GIF picture.');
  let blob: Blob = file;
  if (file.type !== 'image/gif') {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    if (scale < 1 || file.type === 'image/webp' || file.size > 600_000) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const made = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.88));
      if (made) blob = made;
    }
  }
  const result = await api.putBlob<{ url: string }>('/media', blob, { 'x-file-name': encodeURIComponent(file.name) });
  return result.url;
}
