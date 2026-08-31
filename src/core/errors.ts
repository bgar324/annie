export class ModelSafeError<Code extends string = string> extends Error {
  readonly code: Code;

  constructor(name: string, code: Code, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = name;
    this.code = code;
  }
}
