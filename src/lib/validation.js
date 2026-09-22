import Joi from 'joi';
import { AppError } from './errors.js';

export function validate(schema, input) {
  const { value, error } = schema.required().validate(input, { abortEarly: true, allowUnknown: false });
  if (error) throw new AppError(400, 'VALIDATION_ERROR', error.details[0].message);
  return value;
}

export function uuid(value) {
  return validate(Joi.string().guid({ version: ['uuidv4'] }).required(), value);
}

export function pagination(query = {}) {
  return validate(Joi.object({
    limit: Joi.number().integer().min(1).max(100).default(20),
    offset: Joi.number().integer().min(0).max(100000).default(0),
  }), { limit: query.limit, offset: query.offset });
}
