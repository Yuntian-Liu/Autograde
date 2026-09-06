import { Style, Avatar } from "@dicebear/core";
import micahDefinition from "@dicebear/styles/micah.json";

const micahStyle = new Style(micahDefinition);

// DiceBear micah 本地渲染（与 Stellaris 同款头像）：零网络请求，DB 只存 seed
export function avatarUrl(seed) {
  return new Avatar(micahStyle, { seed: seed || "autograde" }).toDataUri();
}

// 注册时随机头像种子（8 位小写字母数字）
export function randomSeed() {
  return Array.from({ length: 8 }, () =>
    "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]
  ).join("");
}
