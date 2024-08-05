import { Bun } from "../bun"

export const md5Checksum = (content: string) => new Bun.CryptoHasher("md5").update(content).digest("base64")