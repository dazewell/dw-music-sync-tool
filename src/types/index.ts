export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export * from './soundiiz.js';
