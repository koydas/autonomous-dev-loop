import { writeGeneratedFiles } from '../scripts/lib/output_writer.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

jest.mock('node:fs/promises');

describe('writeGeneratedFiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips writing file when content matches existing', async () => {
    const changes = [{
      targetPath: 'test.txt',
      fileContent: 'existing content'
    }];

    const existingContent = 'existing content';
    fs.readFile.mockResolvedValue(existingContent);

    await writeGeneratedFiles(changes);

    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});