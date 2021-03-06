import { field, find, Model, ModelId } from '@phnq/model';
import cryptoRandomString from 'crypto-random-string';

import Account from './Account';

export const AUTH_CODE_SESSION_EXPIRY = 10 * 60 * 1000; // 10 minutes
export const CREDENTIALS_SESSION_EXPIRY = 30 * 24 * 60 * 60 * 1000; // 30 days

class Session extends Model {
  @field public readonly accountId: ModelId;
  @field public readonly token = cryptoRandomString({ length: 20, type: 'url-safe' });
  @field public expiry: Date;
  @field public active = true;
  private _account?: Account;

  public constructor(accountOrId: ModelId | Account) {
    super();
    if (accountOrId instanceof Account) {
      this.accountId = accountOrId.id;
      this._account = accountOrId;
    } else {
      this.accountId = accountOrId;
      this._account = undefined;
    }
    this.expiry = new Date(Date.now() + CREDENTIALS_SESSION_EXPIRY);
  }

  public get isValid(): boolean {
    return this.active && this.expiry.getTime() > Date.now();
  }

  public get account(): Promise<Account> {
    return this._account ? Promise.resolve(this._account) : (find(Account, this.accountId) as Promise<Account>);
  }
}

export default Session;
