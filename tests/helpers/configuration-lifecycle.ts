import type { ConfigurationVersionSourceType } from '../../src/modules/configuration-versions';
import { api } from './http';

/**
 * Final BE-27 integration helper: configuration writes create DRAFT versions,
 * so focused effective-read tests must explicitly validate, publish, and
 * activate the version they intend to consume.
 */
export async function activateLatestConfigurationVersion(
  token: string,
  sourceType: ConfigurationVersionSourceType,
  sourceConfigurationId: string,
): Promise<string> {
  const authorization = { Authorization: `Bearer ${token}` };
  const versions = await api()
    .get(
      `/api/v1/configuration-sources/${sourceType}/${sourceConfigurationId}/versions`,
    )
    .set(authorization);
  if (versions.status !== 200 || versions.body.data.length === 0) {
    throw new Error(
      `Unable to load configuration version: ${versions.status} ${JSON.stringify(versions.body)}`,
    );
  }
  const version = versions.body.data.at(-1);
  for (const action of ['validate', 'publish', 'activate'] as const) {
    const response = await api()
      .post(`/api/v1/configuration-versions/${version.id}/${action}`)
      .set(authorization)
      .send({});
    if (response.status !== 200) {
      throw new Error(
        `Unable to ${action} configuration version: ${response.status} ${JSON.stringify(response.body)}`,
      );
    }
  }
  return version.id;
}
