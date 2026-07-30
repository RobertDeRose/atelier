export interface ServiceRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ServiceSuccess {
  id: string;
  ok: true;
  result: unknown;
}

export interface ServiceFailure {
  id: string;
  ok: false;
  error: { message: string; code?: string };
}

export type ServiceResponse = ServiceSuccess | ServiceFailure;
