from setuptools import setup, find_packages

setup(
    name="word-munch-cdk",
    version="1.0.0",
    description="Word Munch Chrome Extension Backend Infrastructure CDK",
    author="Word Munch Team",
    packages=find_packages(),
    install_requires=[
        "aws-cdk-lib>=2.181.1",
        "constructs>=10.0.0,<11.0.0",
    ],
    python_requires=">=3.8",
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
    ],
) 