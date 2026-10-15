/** Only the native Share Sheet's standalone Markdown source link is disposable.
 * Compare URLs literally: fragments (and other destination differences) matter.
 * No multiline labels, images, comments, annotations, or surrounding prose.
 */
export function isSourceLinkPlaceholder(body: string, url: unknown): boolean {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return false;
  const link = /^\[([^\[\]\r\n]+)\]\((https?:\/\/[^\s()<>]+)\)$/.exec(body.trim());
  return !!link && link[2] === url && !/[=<>`\\]/.test(link[1]!);
}
