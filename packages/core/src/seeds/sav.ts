import type { Db } from '../db';

/** Extra demo data for the sav feature (runs after the main demo seed). users: demo account key → id. */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  void db;
  void users;
  void now;
}
