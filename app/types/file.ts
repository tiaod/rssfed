export interface FileRecord {
  id: string
  storage: string
  filenameDisk: string
  filenameDownload: string
  type: string
  size: number
  title: string | null
  tags: string[] | null
  width: number | null
  height: number | null
  duration: number | null
  isPublic: boolean
  uploadedBy: string | null
  path: string | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface FileUploadResponse {
  success: boolean
  file: {
    id: string
    filename: string
    size: number
    type: string
    url: string | undefined
    createdAt: Date
  }
}
