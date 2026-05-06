/**
 * LanemuNetworkService.ts — Handles virtual IP detection and connectivity tests.
 */

export interface NetworkInterface {
  name: string;
  address: string;
  netmask: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
}

export interface INetworkService {
  getInterfaces(): Promise<NetworkInterface[]>;
  ping(ip: string): Promise<boolean>;
  checkTcpPort(ip: string, port: number): Promise<boolean>;
}

export class LanemuNetworkService {
  private _network: INetworkService;

  constructor(network: INetworkService) {
    this._network = network;
  }

  /** Detect the virtual IP assigned by LANemu (typically in the 10.6.x.x range). */
  async detectVirtualIp(): Promise<{ address: string; name: string } | null> {
    const interfaces = await this._network.getInterfaces();
    // Scan for IPv4 addresses in the 10.6.0.0/16 range used by LANemu
    const virtual = interfaces.find(
      (iface) => iface.family === "IPv4" && iface.address.startsWith("10.6.")
    );
    return virtual ? { address: virtual.address, name: virtual.name } : null;
  }

  async testConnection(ip: string): Promise<boolean> {
    return this._network.ping(ip);
  }

  async ping(ip: string): Promise<boolean> {
    return this._network.ping(ip);
  }

  async testGamePort(ip: string, port: number): Promise<boolean> {
    return this._network.checkTcpPort(ip, port);
  }
}
