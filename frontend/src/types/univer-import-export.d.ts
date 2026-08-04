import type { IWorkbookData } from '@univerjs/core';

declare module '@mertdeveci55/univer-import-export' {
  interface LuckyExcelApi {
    transformExcelToUniver(
      file: File,
      success: (snapshot: IWorkbookData) => void,
      error: (error: unknown) => void,
    ): void;
  }

  export const LuckyExcel: LuckyExcelApi;
}
