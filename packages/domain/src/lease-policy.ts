export interface LeaseRecordLike {
  leaseOwner: string;
  leaseToken: string;
  leaseUntil: Date;
}

export function isLeaseExpired(leaseUntil: Date, now: Date): boolean {
  return leaseUntil.getTime() <= now.getTime();
}

export function canRenewLease(lease: LeaseRecordLike, leaseOwner: string, leaseToken: string, now: Date): boolean {
  return lease.leaseOwner === leaseOwner && lease.leaseToken === leaseToken && !isLeaseExpired(lease.leaseUntil, now);
}
