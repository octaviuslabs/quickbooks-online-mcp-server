import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

/**
 * Make a vendor inactive in QuickBooks Online.
 *
 * QBO does not support deleting list entities such as vendors, and
 * node-quickbooks does not expose a deleteVendor method. A sparse update is
 * the supported equivalent.
 */
export async function deleteQuickbooksVendor(vendor: any): Promise<ToolResponse<any>> {
  try {
    const quickbooks = await QuickbooksClient.getInstance();
    const inactiveVendor = {
      Id: vendor.Id,
      SyncToken: vendor.SyncToken,
      Active: false,
      sparse: true,
    };

    return new Promise((resolve) => {
      quickbooks.updateVendor(inactiveVendor, (err: any, updatedVendor: any) => {
        if (err) {
          resolve({
            result: null,
            isError: true,
            error: formatError(err),
          });
        } else {
          resolve({
            result: updatedVendor,
            isError: false,
            error: null,
          });
        }
      });
    });
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
