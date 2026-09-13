import { SoundiizApiClient } from '../api/index.js';

export * from './backupEngine.js';

export class PlaylistService {
  constructor(private api: SoundiizApiClient) {}

  public async getUserPlaylists() {
    return [];
  }
}
