const path = require('path');

describe('Frontend Insights Tool', () => {
  let frontendInsightsTool, handleFrontendInsights, FRONTEND_INSIGHTS_SCHEMA;

  beforeAll(() => {
    try {
      const module = require('../dist/src/tools/localTools/frontendInsights.js');
      frontendInsightsTool = module.frontendInsightsTool;
      handleFrontendInsights = module.handleFrontendInsights;
      FRONTEND_INSIGHTS_SCHEMA = module.FRONTEND_INSIGHTS_SCHEMA;
    } catch (error) {
      console.warn('Frontend insights module not available:', error.message);
    }
  });

  it('should import frontend_insights tool successfully', () => {
    expect(frontendInsightsTool).toBeDefined();
    expect(frontendInsightsTool.name).toBeDefined();
    expect(frontendInsightsTool.description).toBeDefined();
  });

  it('should validate schema correctly', () => {
    if (!FRONTEND_INSIGHTS_SCHEMA) {
      console.warn('Schema not available, skipping test');
      return;
    }

    const validArgs = {
      projectPath: path.resolve('.'),
      format: 'structured',
      includeContent: true,
      subtree: 'web/app',
      maxFiles: 10
    };

    const result = FRONTEND_INSIGHTS_SCHEMA.safeParse(validArgs);
    expect(result.success).toBe(true);
  });

  it('should execute tool without errors', async () => {
    if (!handleFrontendInsights) {
      console.warn('Handler not available, skipping test');
      return;
    }

    const validArgs = {
      projectPath: path.resolve('.'),
      format: 'structured',
      includeContent: true,
      subtree: 'src', // Use src instead of web/app since this is not a web project
      maxFiles: 5
    };

    const response = await handleFrontendInsights(validArgs);
    expect(response).toBeDefined();
    expect(response.content).toBeDefined();
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.content[0].type).toBe('text');
    expect(response.content[0].text).toBeDefined();
  }, 30000);
});