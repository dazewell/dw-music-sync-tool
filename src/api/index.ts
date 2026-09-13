import axios, { AxiosInstance } from 'axios';
import { config } from '../config/index.js';

export * from './soundiizClient.js';

export class SoundiizApiClient {
  private client: AxiosInstance;

  constructor(apiKey = config.soundiizApiKey, baseUrl = config.soundiizApiUrl) {
    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  public getClient(): AxiosInstance {
    return this.client;
  }
}
