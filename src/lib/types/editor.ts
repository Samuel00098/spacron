export type EditorFileKind = 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'docx';

export interface EditorFile {
  path: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
  language: string;
  kind: EditorFileKind;
  /** What the viewer shows for an image, audio or video file: a blob: URL,
   *  or an asset-protocol URL streamed from disk. */
  imageSrc?: string | null;
  documentData?: Uint8Array;
  mimeType?: string | null;
  size?: number | null;
}
