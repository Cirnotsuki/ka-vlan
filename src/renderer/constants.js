export const PROTO_VERSION = 1;
export const DEFAULT_WG_PORT = 1212;
export const DEFAULT_SERVER_PORT = 12580;
export const VPN_PREFIX = '10.84.111.';
export const POOL_FIRST = 2; // .1 固定给服务器
export const POOL_LAST = 254;
export const LOCAL_ID = 0;
export const LOCAL_NAME = '';
export const NETWORK_NAME = 'UsagiNetwork';
export const SERVER_VPN_IP = `${VPN_PREFIX}1`;

// users.status
export const ST_DELETED = -1;
export const ST_BANNED = 0;
export const ST_NORMAL = 1;

export const MAX_BODY = 1024 * 1024;
export const IS_LOST_CONNECT = 5 * 1000;
