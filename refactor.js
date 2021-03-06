const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');
const fs = require('fs');

const code = fs.readFileSync('./examples/simple/AstExplorerExample.jsx', {
  encoding: 'utf8',
});

const ast = parser.parse(code, { sourceType: 'module', plugins: ['jsx'] });

// * helper functions
function checkIfTargetJSXComponent(functionPath) {
  const funcName = functionPath.node.id.name;

  const programPath = functionPath.findParent(t.isProgram);
  const exportNode = programPath.node.body.find(
    (code) => code.type === 'ExportDefaultDeclaration'
  );

  if (exportNode.declaration.name !== funcName) {
    return false;
  }

  // Remove ReturnStatement from BlockStatement
  const funcCodeBlock = functionPath.node.body.body;
  const blockLen = funcCodeBlock.length;
  const lastElement = funcCodeBlock[blockLen - 1];

  if (lastElement.type !== 'ReturnStatement') {
    throw SyntaxError(
      'The return statement should be at the end of the function.'
    );
  } else if (lastElement.argument.type !== 'JSXElement') {
    throw SyntaxError(
      'The default exported function should return a JSX element.'
    );
  }

  return true;
}

function getComponentBodyPath(path, componentFuncPath) {
  const bodyNodePath = path.findParent(
    (currPath) => currPath.parentPath.parentPath === componentFuncPath
  );

  return bodyNodePath;
}

function getReactiveNodeForIdentifier(
  identifierPath,
  componentFuncPath,
  compiledStatePaths
) {
  // propUsed = true;
  const $ = t.identifier('$'); // label

  // Not reactive if passed as initial value to useState
  const callExpr = identifierPath.findParent(t.isCallExpression);
  if (callExpr && callExpr.node.callee.name === 'useState') {
    return { parentToBeReplaced: null, reactiveLabel: null };
  }

  const alreadyReactive = identifierPath.findParent(t.isLabeledStatement);
  if (alreadyReactive) {
    return { parentToBeReplaced: null, reactiveLabel: null };
  }

  const parentFunctionPath = identifierPath.getFunctionParent();
  const isNestedFunction = parentFunctionPath !== componentFuncPath;
  if (isNestedFunction) {
    return { parentToBeReplaced: null, reactiveLabel: null };
  }

  // TODO: handle conditional rendering
  const isReturn = identifierPath.findParent(t.isReturnStatement);
  if (isReturn) {
    return { parentToBeReplaced: null, reactiveLabel: null };
  }

  let componentBodyPath = getComponentBodyPath(
    identifierPath,
    componentFuncPath
  );

  let reactiveLabel = null;
  const bodyNode = componentBodyPath.node;

  if (bodyNode && !compiledStatePaths.includes(bodyNode)) {
    if (bodyNode.type === 'VariableDeclaration') {
      const asnExp = t.assignmentExpression(
        '=',
        bodyNode.declarations[0].id,
        bodyNode.declarations[0].init
      );
      const exprStmnt = t.expressionStatement(asnExp);
      reactiveLabel = t.labeledStatement($, exprStmnt);
    } else if (t.isStatement(bodyNode)) {
      reactiveLabel = t.labeledStatement($, bodyNode);
    } else {
      componentBodyPath = null;
    }
  } else {
    componentBodyPath = null;
  }

  return { parentToBeReplaced: componentBodyPath, reactiveLabel };
}

function getExportNodeForProp(propName) {
  const identifier = t.identifier(propName);
  const vDeclarator = t.variableDeclarator(identifier);
  const vDeclaration = t.variableDeclaration('let', [vDeclarator]);
  const namedExport = t.exportNamedDeclaration(vDeclaration, [], null);

  return namedExport;
}

function getPropNames(funcPath) {
  const params = funcPath.node.params;
  const hasProps = !!params.length;
  const propsObject = params[0];
  let props = [];

  if (!hasProps) {
    return null;
  }

  if (propsObject.type === 'ObjectPattern') {
    props = propsObject.properties.map((objProp) => objProp.value.name);
  }

  return props;
}

function getDeclarationForUseState(idPath) {
  const callExprPath = idPath.parentPath;
  const lVal = callExprPath.container.id;
  let vDeclaration = null;
  let setterFunctionName = null;
  let stateVariableName = null;

  if (lVal.type === 'ArrayPattern') {
    // array destructured form
    stateVariableName = lVal.elements[0].name;
    setterFunctionName = lVal.elements[1].name;

    const argNode = callExprPath.node.arguments[0];

    const vDectr = t.variableDeclarator(
      t.identifier(stateVariableName),
      argNode
    );

    vDeclaration = t.variableDeclaration('let', [vDectr]);
  }

  return { vDeclaration, stateVariableName, setterFunctionName };
}

function getAsmntNodeForSetter(idPath, stateVariableName, funcPath) {
  let out = { callExprPath: null, asnExpr: null };
  const callExprPath = idPath.findParent(t.isCallExpression);

  if (!callExprPath) {
    return out;
  }

  const asnExpr = t.assignmentExpression(
    '=',
    t.identifier(stateVariableName),
    callExprPath.node.arguments[0]
  );
  // callExpr.replaceWith(asnExpr);

  return { callExprPath, asnExpr };
}

function getContainingFunction(path) {
  const func = path.getFunctionParent() || {};
  const name = null;

  if (
    func.type === 'FunctionExpression' ||
    func.type === 'ArrowFunctionExpression'
  ) {
    if (func.container.type === 'VariableDeclarator') {
      name = func.container.id.name;
    } else if (func.container.type === 'AssignmentExpression') {
      name = func.container.left.name;
    }
  } else if (func.type === 'FunctionDeclaration') {
    name = func.id.name;
  }

  return { name, path: func };
}

// * list map helpers
function getListMapCode({ objName, elementName, jsxElem, key }) {
  const out = `{#each ${objName} as ${elementName} (${key})}${
    generate(jsxElem, {}).code
  }{/each}`;
  // keyNode.remove();

  return out;
}

function getKeyAttrPath(callExprPath) {
  let keypath = null;
  callExprPath.traverse({
    JSXAttribute(jsxAttrPath) {
      if (jsxAttrPath.node.name.name !== 'key') {
        return;
      }

      keypath = jsxAttrPath;
    },
  });

  return keypath;
}

function getLoopNode(codeString) {
  const openingElem = t.jsxOpeningElement(t.jsxIdentifier('HTMLxBlock'), []);
  const closingElem = t.jsxClosingElement(t.jsxIdentifier('HTMLxBlock'));
  const jsxExpr = t.jsxExpressionContainer(t.stringLiteral(codeString));
  const children = [jsxExpr];

  return t.jsxElement(openingElem, closingElem, children);
}

// * processing functions
const compiledStateBodyNodePaths = [];
function processProps(idPath, funcPath) {
  const propsNames = getPropNames(funcPath);

  const identifierName = idPath.node.name;
  // console.log('id: ' + identifierName);

  // compile props
  if (propsNames.includes(identifierName)) {
    // console.log('prop used: ' + identifierName);
    const { parentToBeReplaced, reactiveLabel } = getReactiveNodeForIdentifier(
      idPath,
      funcPath,
      compiledStateBodyNodePaths
    );

    if (parentToBeReplaced) {
      if (reactiveLabel) parentToBeReplaced.replaceWith(reactiveLabel);
      else {
        parentToBeReplaced.remove();
      }
    }

    return true;
  }

  return false;
}

let useState = 'useState';
const stateVariables = {
  /* setterFunctionName, decNode */
};
const setterFunctions = {};
function processState(idPath, funcPath) {
  // TODO: detect aliases
  const isStateVariable = stateVariables[idPath.node.name] !== undefined;
  if (isStateVariable) {
    let parentDec = idPath.findParent(t.isVariableDeclaration);
    let isStateDeclaration =
      parentDec && stateVariables[idPath.node.name].decNode === parentDec.node;
    if (isStateDeclaration) {
      // Don't replace state declaration. After useState is replaced with VariableDeclaration,
      // it is immediately revisited, we do not want to replace it
      return false;
    }

    const { parentToBeReplaced, reactiveLabel } = getReactiveNodeForIdentifier(
      idPath,
      funcPath,
      compiledStateBodyNodePaths
    );
    if (parentToBeReplaced) parentToBeReplaced.replaceWith(reactiveLabel);
    return true;
  }

  // TODO: setter functions
  const isSetter = setterFunctions[idPath.node.name] !== undefined;
  if (isSetter) {
    const { callExprPath, asnExpr } = getAsmntNodeForSetter(
      idPath,
      setterFunctions[idPath.node.name]
    );

    if (!callExprPath) {
      return false;
    }

    callExprPath.replaceWith(asnExpr); // ! replace the function call
    const hasLabeledParent = callExprPath.findParent(t.isLabeledStatement);
    const isInsideFuncDecl = callExprPath.findParent(t.isFunctionDeclaration);

    // ? function declarations
    // ? return statement
    if (!hasLabeledParent && !isInsideFuncDecl) {
      const bodyNodePath = getComponentBodyPath(idPath, funcPath);
      const labeledStatement = t.labeledStatement(
        t.identifier('$'),
        bodyNodePath.node
      );

      // ! if necessary, replace containing statement with a reactive one
      bodyNodePath.replaceWith(labeledStatement);
    }
  }

  if (
    idPath.node.name === useState &&
    idPath.container.type === 'CallExpression'
  ) {
    const {
      vDeclaration,
      stateVariableName,
      setterFunctionName,
    } = getDeclarationForUseState(idPath);

    if (vDeclaration) {
      const bodyNode = getComponentBodyPath(idPath, funcPath);
      bodyNode.replaceWith(vDeclaration);

      stateVariables[stateVariableName] = {
        setterFunctionName,
        decNode: vDeclaration,
      };
      setterFunctions[setterFunctionName] = stateVariableName;
      compiledStateBodyNodePaths.push(vDeclaration);
      return true;
    }

    // TODO: non-destructured pattern
  }

  return false;
}

const jsxVariables = {};
function processJSXVariable(idPath) {
  const isRefToJSXVar = jsxVariables[idPath.node.name];
  const isBeingReturned = idPath.container.type === 'ReturnStatement';
  const isRefedInJSXExpression =
    idPath.container.type === 'JSXExpressionContainer';

  if (!isRefToJSXVar || (!isBeingReturned && !isRefedInJSXExpression)) {
    // * noop
    return false;
  }

  const name = idPath.node.name;

  if (isBeingReturned) {
    // * keep the return statement, just dereference the identifier
    idPath.replaceWith(jsxVariables[idPath.node.name].node);
  } else {
    idPath.parentPath.replaceWith(jsxVariables[idPath.node.name].node);
  }
}

// * main
let scriptNodes = [];
const jsxElements = { mainJSXElementPath: {}, others: {} };
const allJSXReturns = [];

const defaultExport = {};

const exportDetectionPlugin = {
  ExportDefaultDeclaration(exportPath) {
    switch (exportPath.node.declaration.type) {
      case 'Identifier':
        defaultExport.id = exportPath.get('declaration');
        break;
      case 'FunctionDeclaration':
      case 'ArrowFunctionExpression':
        defaultExport.function = exportPath.get('declaration');
        break;
      case 'AssignmentExpression':
        if (
          exportPath.node.declaration.right.type !== 'FunctionDeclaration' &&
          exportPath.node.declaration.right.type !== 'ArrowFunctionExpression'
        ) {
          throw Error('Input file has to export a function that returns JSX');
        }
        defaultExport.function = exportPath.get('declaration.right');
        break;
      default:
        throw Error('Input file has to export a function that returns JSX');
        break;
    }
  },
};

traverse(ast, exportDetectionPlugin);

if (defaultExport.id) {
  const findComponentFunctionPlugin = {
    VariableDeclarator(vdPath) {
      if (
        vdPath.node.id.name !== defaultExport.id.node.name ||
        vdPath.parentPath.parentPath.type !== 'Program'
      ) {
        return;
      }

      if (
        vdPath.node.init.type !== 'FunctionExpression' &&
        vdPath.node.init.type !== 'ArrowFunctionExpression'
      ) {
        throw Error('Input file has to export a function that returns JSX');
      }

      defaultExport.function = vdPath.get('init');
    },
    AssignmentExpression(asmntPath) {
      if (
        asmntPath.node.left.name !== defaultExport.id.node.name ||
        asmntPath.parentPath.parentPath.type !== 'Program'
      ) {
        return;
      }

      if (
        asmntPath.node.right.type !== 'FunctionExpression' &&
        asmntPath.node.right.type !== 'ArrowFunctionExpression'
      ) {
        throw Error('Input file has to export a function that returns JSX');
      }

      defaultExport.function = asmntPath.get('right');
    },
    FunctionDeclaration(funcPath) {
      if (funcPath.node.id.name !== defaultExport.id.node.name) {
        return;
      }

      defaultExport.function = funcPath;
    },
  };
  traverse(ast, findComponentFunctionPlugin);
}

if (!defaultExport.function) {
  throw Error('Input file has to export a function that returns JSX');
}

const propsNames = getPropNames(defaultExport.function);

// * add export statement for each prop
propsNames.forEach((propName) => {
  scriptNodes.push(getExportNodeForProp(propName));
});

const listMaps = [];
const funcPath = defaultExport.function;
funcPath.get('body').traverse({
  // ! modifies the jsxVariables object
  VariableDeclarator(declaratorPath) {
    const varName = declaratorPath.node.id.name;
    const val = declaratorPath.node.init;

    if (val.type === 'JSXElement') {
      jsxVariables[varName] = declaratorPath.get('init');
    }
  },
  // ! modifies the jsxVariables object
  AssignmentExpression(assignmentPath) {
    const varName = assignmentPath.node.left.name;
    const val = assignmentPath.node.right;

    if (val.type === 'JSXElement') {
      jsxVariables[varName] = assignmentPath.get('right');
    }
  },
  // ! throws if JSX is found inside a loop, conditional body or a function
  // !   that is not a callback to list.map
  JSXElement(jsxPath) {
    // !throw if inside loop
    const isInLoop = jsxPath.findParent((path) => {
      return (
        t.isForXStatement(path) || t.isForStatement(path) || t.isWhile(path)
      );
    });

    if (isInLoop) {
      throw Error('JSX inside loops cannot be compiled');
    }

    // ! throw if inside conditional
    const isInConditional = jsxPath.findParent(t.isConditional);
    if (isInConditional) {
      throw Error('JSX inside conditionals cannot be compiled');
    }

    // ! throw if inside a function
    const funcDecl = jsxPath.findParent(t.isFunction);
    const callExpr = jsxPath.findParent(t.isCallExpression);

    const funcIsInComponentBody = funcDecl === funcPath;
    const funcIsCallbackPassedToListMap =
      callExpr &&
      callExpr.node.callee.type === 'MemberExpression' &&
      callExpr.node.callee.property.name === 'map';

    if (!funcIsInComponentBody && !funcIsCallbackPassedToListMap) {
      throw Error(
        'It seems like you have a JSX element inside function. This is not supported.'
      );
    }
  },
  // ! replace call to `list.map` with <HTMLxBlock> JSX element
  CallExpression(callExprPath) {
    const callNode = callExprPath.node;

    if (
      callNode.callee.type === 'MemberExpression' &&
      callNode.callee.property.name === 'map'
    ) {
      const callback = callNode.arguments[0];
      const objName = callNode.callee.object.name;
      const elementName = callback.params[0].name;
      let keyAttrPath;
      let jsxElem = {};

      if (callback.body.type === 'JSXElement') {
        jsxElem = callback.body;
      } else if (callback.body.body[0].type === 'ReturnStatement') {
        jsxElem = callback.body.body[0].argument;
      } else {
        console.warn(
          'Callback passed to map must return JSX and cannot have other code in its body'
        );
        return;
      }

      keyAttrPath = getKeyAttrPath(callExprPath);
      const keyCode = generate(keyAttrPath.node.value.expression, {}).code;
      keyAttrPath.remove();
      const loopCodeString = getListMapCode({
        objName,
        elementName,
        jsxElem,
        key: keyCode,
      });
      const loopJSXElem = getLoopNode(loopCodeString); // HTMLxBlock
      // console.log(generate(loopJSXElem).code);
      const jsxExpr = callExprPath.findParent(t.isJSXExpressionContainer);
      if (jsxExpr) {
        jsxExpr.replaceWith(loopJSXElem);
      } else {
        callExprPath.replaceWith(loopJSXElem);
      }

      listMaps.push({ objName, elementName, jsxElem, keyAttrPath });
    }
  },
  // ! props and state processing, JSX variable inlining
  Identifier(idPath) {
    const propsProcessed = processProps(idPath, funcPath); // ! Side Effect: modifies AST
    if (propsProcessed) return;

    // ! modifies AST: replace `useState` call with declarations
    // ! Replace state access and setterfunc call with reactive variables
    let useStateReplaced = processState(idPath, funcPath);
    if (useStateReplaced) return;

    // ! modifies AST: replace references to variables with JSX values with inline JSX
    let jsxRemoved = processJSXVariable(idPath, funcPath);
    if (jsxRemoved) return;
  },
});

funcPath.get('body').traverse({
  VariableDeclarator(declaratorPath) {
    const varName = declaratorPath.node.id.name;
    const val = declaratorPath.node.init;

    if (
      val.type === 'JSXElement' &&
      val.openingElement.name.name === 'HTMLxBlock'
    ) {
      jsxVariables[varName] = declaratorPath.get('init');
    }
  },
  AssignmentExpression(assignmentPath) {
    const varName = assignmentPath.node.left.name;
    const val = assignmentPath.node.right;

    if (
      val.type === 'JSXElement' &&
      val.openingElement.name.name === 'HTMLxBlock'
    ) {
      jsxVariables[varName] = assignmentPath.get('right');
    }
  },
  Identifier(idPath) {
    processJSXVariable(idPath, funcPath);
  },
});

// ! modifies AST: remove all JSX assignments to variables
Object.values(jsxVariables).forEach((jsxVariable) =>
  getComponentBodyPath(jsxVariable, funcPath).remove()
);

scriptNodes = scriptNodes.concat(funcPath.node.body.body);

let out = '<script>\n';

scriptNodes.forEach((node) => {
  out += '  ' + generate(node, { comments: false }).code + '\n\n';
});

out += '</script>\n\n';

out = out.replace(/<HTMLxBlock>{"/g, '');
out = out.replace(/"}<\/HTMLxBlock>/g, '');

console.log(out);

fs.writeFileSync(`./out/out${Date.now()}.svelte`, out, { encoding: 'utf8' });
