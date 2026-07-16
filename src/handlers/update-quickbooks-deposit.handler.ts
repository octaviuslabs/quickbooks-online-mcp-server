import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export interface UpdateDepositInput {
  id: string;
  sync_token: string;
  private_note?: string;
}

export async function updateQuickbooksDeposit(data: UpdateDepositInput): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();
    const existing = await new Promise<any>((resolve, reject) => {
      (quickbooks as any).getDeposit(data.id, (err: any, deposit: any) => {
        if (err) reject(err);
        else resolve(deposit);
      });
    });

    const payload: any = {
      ...existing,
      Id: data.id,
      SyncToken: data.sync_token,
      sparse: false,
    };
    delete payload.domain;
    delete payload.MetaData;

    if (data.private_note !== undefined) {
      payload.PrivateNote = data.private_note;
    }

    const updated = await new Promise<any>((resolve, reject) => {
      (quickbooks as any).updateDeposit(payload, (err: any, result: any) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    return { result: updated, isError: false, error: null };
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
