/** Client-safe: the Google scopes a connection asks for (docs/connections.md). */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const CONNECT_SCOPES = ["openid", "email", DRIVE_FILE_SCOPE] as const;
/** The Drive type of a Google Docs document. */
export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
