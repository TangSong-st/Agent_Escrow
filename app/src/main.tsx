import { Buffer } from "buffer";

globalThis.Buffer = Buffer;

void import("./render");
