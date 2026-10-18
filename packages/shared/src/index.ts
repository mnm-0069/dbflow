export type DatabaseEngine = 'postgres' | 'mysql';
export type ConnectionTestRequest = {
  engine: DatabaseEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
};
export type ConnectionTestResponse = {
  success: true;
  engine: DatabaseEngine;
  latencyMs: number;
  serverVersion: string;
};
