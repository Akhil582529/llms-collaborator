const fs = require('fs');
const path = require('path');

function checkFrontendCompleteness(
  frontendDir,
  techStack = null
) {
  const issues = [];

  const packagePath =
    path.join(
      frontendDir,
      'package.json'
    );

  let packageJson = null;

  try {
    packageJson =
      JSON.parse(
        fs.readFileSync(
          packagePath,
          'utf8'
        )
      );
  } catch (error) {
    issues.push(
      `frontend/package.json is missing or invalid JSON: ${error.message}`
    );
  }

  if (
    packageJson &&
    typeof packageJson.scripts?.start !==
      'string'
  ) {
    issues.push(
      'frontend/package.json must define a start script.'
    );
  }

  const frontend =
    techStack?.frontend;

  if (frontend === 'react') {
    if (
      !fs.existsSync(
        path.join(
          frontendDir,
          'src',
          'index.js'
        )
      )
    ) {
      issues.push(
        'React frontend is missing src/index.js.'
      );
    }

    if (
      !fs.existsSync(
        path.join(
          frontendDir,
          'public',
          'index.html'
        )
      )
    ) {
      issues.push(
        'React frontend is missing public/index.html.'
      );
    }
  } else if (frontend === 'vue') {
    if (
      !fs.existsSync(
        path.join(
          frontendDir,
          'src',
          'main.js'
        )
      )
    ) {
      issues.push(
        'Vue frontend is missing src/main.js.'
      );
    }

    if (
      !fs.existsSync(
        path.join(
          frontendDir,
          'index.html'
        )
      )
    ) {
      issues.push(
        'Vue frontend is missing index.html.'
      );
    }
  } else if (frontend === 'angular') {
    if (
      !fs.existsSync(
        path.join(
          frontendDir,
          'src',
          'main.ts'
        )
      )
    ) {
      issues.push(
        'Angular frontend is missing src/main.ts.'
      );
    }
  } else {
    const entries = [
      'src/index.js',
      'src/main.js',
      'src/main.ts',
    ];

    if (
      !entries.some((entry) =>
        fs.existsSync(
          path.join(
            frontendDir,
            entry
          )
        )
      )
    ) {
      issues.push(
        'frontend needs a framework entry file: src/index.js, src/main.js, or src/main.ts.'
      );
    }
  }

  /*
   * Never allow package metadata
   * inside src.
   */
  const srcPackage =
    path.join(
      frontendDir,
      'src',
      'package.json'
    );

  if (
    fs.existsSync(srcPackage)
  ) {
    issues.push(
      'frontend/src/package.json must not exist.'
    );
  }

  /*
   * A frontend without source
   * files is not complete.
   */
  const srcDir =
    path.join(
      frontendDir,
      'src'
    );

  if (
    fs.existsSync(srcDir)
  ) {
    const files =
      fs.readdirSync(
        srcDir,
        {
          withFileTypes: true,
        }
      );

    const sourceFiles =
      files.filter(
        (file) =>
          file.isFile() &&
          /\.(js|jsx|ts|tsx|vue)$/.test(
            file.name
          )
      );

    if (
      sourceFiles.length === 0
    ) {
      issues.push(
        'frontend/src contains no source files.'
      );
    }
  }

  return {
    clean: issues.length === 0,
    issues,
  };
}

module.exports = {
  checkFrontendCompleteness,
};