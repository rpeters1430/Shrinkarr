export interface MediaServerClient {
  notifyLibraryChanged(): Promise<void>;
}
